import os
import sys
import time
import shutil
import json
import uuid
import datetime
import asyncio
import base64
import tempfile
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks, Response
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
import urllib.request
from pdf_utils import convert_pdf_to_images

# Define paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data", "tasks")

# Ensure base task directory exists
os.makedirs(DATA_DIR, exist_ok=True)

# GPU availability check
GPU_AVAILABLE = False

def check_gpu_available() -> bool:
    try:
        # Run a process-isolated check using paddle inside our project env
        res = shutil.which("nvidia-smi")
        if not res:
            return False
        
        # Verify with paddle device count
        import subprocess
        check_cmd = [
            sys.executable, "-c",
            "import paddle; print(paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0)"
        ]
        # ponytail: importing paddle alone takes >5s, so the old 5s timeout always
        # expired -> GPU went undetected and every pipeline silently ran on CPU.
        result = subprocess.run(check_cmd, capture_output=True, text=True, timeout=120)
        return result.stdout.strip() == "True"
    except Exception as e:
        print(f"Error checking GPU availability: {e}")
        return False

# Global lock/dict to store active tasks to avoid race conditions or double updates
active_tasks = {}

def load_metadata(task_id: str) -> dict:
    meta_path = os.path.join(DATA_DIR, task_id, "metadata.json")
    if not os.path.exists(meta_path):
        raise HTTPException(status_code=404, detail="Task not found")
    with open(meta_path, "r") as f:
        return json.load(f)

def save_metadata(task_id: str, data: dict):
    task_dir = os.path.join(DATA_DIR, task_id)
    os.makedirs(task_dir, exist_ok=True)
    meta_path = os.path.join(task_dir, "metadata.json")
    with open(meta_path, "w") as f:
        json.dump(data, f, indent=4)

def download_url_sync(url: str, dest_path: str):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as response, open(dest_path, 'wb') as out_file:
        out_file.write(response.read())

async def run_extraction_task(task_id: str, source_path: str, dpi: int, pipeline: str, device: str):
    # Set status to running
    metadata = load_metadata(task_id)
    metadata["status"] = "running"
    metadata["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save_metadata(task_id, metadata)
    
    task_dir = os.path.join(DATA_DIR, task_id)
    output_dir = os.path.join(task_dir, "output")
    os.makedirs(output_dir, exist_ok=True)
    
    try:
        # Build compare.py command line
        compare_script = os.path.join(BASE_DIR, "compare.py")
        
        # We spawn the subprocess and let it print stdout/stderr directly to parent server console
        process = await asyncio.create_subprocess_exec(
            sys.executable, compare_script,
            "--source", source_path,
            "--output-dir", output_dir,
            "--dpi", str(dpi),
            "--device", device,
            "--pipeline", pipeline,
        )
        
        # Wait for the subprocess to complete
        returncode = await process.wait()
        
        metadata = load_metadata(task_id) # reload to merge changes
        
        if returncode == 0:
            # Locate the output subfolder named after the PDF name
            pdf_base_dir = None
            if os.path.exists(output_dir):
                for entry in os.listdir(output_dir):
                    entry_path = os.path.join(output_dir, entry)
                    if os.path.isdir(entry_path):
                        pdf_base_dir = entry_path
                        break
            
            stats = {}
            if pdf_base_dir:
                stats_docling_path = os.path.join(pdf_base_dir, "stats_docling.json")
                stats_paddle_path = os.path.join(pdf_base_dir, "stats_paddleocr.json")
                
                if os.path.exists(stats_docling_path):
                    try:
                        with open(stats_docling_path, "r") as f:
                            stats.update(json.load(f))
                    except Exception as e:
                        print(f"Error loading docling stats: {e}")
                        
                if os.path.exists(stats_paddle_path):
                    try:
                        with open(stats_paddle_path, "r") as f:
                            stats.update(json.load(f))
                    except Exception as e:
                        print(f"Error loading paddleocr stats: {e}")
            
            metadata["status"] = "completed"
            metadata["stats"] = stats
        else:
            metadata["status"] = "failed"
            metadata["error"] = f"Extraction process exited with code {returncode}"
            
    except Exception as e:
        import traceback
        metadata["status"] = "failed"
        metadata["error"] = f"Exception: {str(e)}\n{traceback.format_exc()}"
        
    metadata["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save_metadata(task_id, metadata)

async def cleanup_loop():
    print("[Cleanup] Starting hourly task cleanup loop...")
    while True:
        try:
            now = time.time()
            cutoff = now - 24 * 3600  # 24 hours
            if os.path.exists(DATA_DIR):
                for task_id in os.listdir(DATA_DIR):
                    task_path = os.path.join(DATA_DIR, task_id)
                    if os.path.isdir(task_path):
                        meta_path = os.path.join(task_path, "metadata.json")
                        mtime = os.path.getmtime(task_path)
                        if os.path.exists(meta_path):
                            mtime = os.path.getmtime(meta_path)
                        if mtime < cutoff:
                            shutil.rmtree(task_path)
                            print(f"[Cleanup] Purged expired task: {task_id}")
        except Exception as e:
            print(f"[Cleanup] Error in cleanup loop: {e}")
        # Check every hour
        await asyncio.sleep(3600)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Detect GPU availability at startup
    global GPU_AVAILABLE
    print("[Startup] Detecting GPU availability...")
    GPU_AVAILABLE = await run_in_threadpool(check_gpu_available)
    print(f"[Startup] GPU Available: {GPU_AVAILABLE}")
    
    # Start cleanup background task
    cleanup_task = asyncio.create_task(cleanup_loop())
    yield
    # Shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass

# Initialize FastAPI App
app = FastAPI(
    title="Paddle & Docling PDF Extraction Microservice",
    description="Microservice comparing Docling and PaddleOCR extraction pipelines on PDF pages.",
    version="1.0.0",
    lifespan=lifespan
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Root Endpoint: Serves front-end UI
@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = os.path.join(BASE_DIR, "static", "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="Index HTML not found")
    with open(index_path, "r", encoding="utf-8") as f:
        return f.read()

# System Status Endpoint
@app.get("/status")
async def get_system_status():
    return {
        "status": "online",
        "gpu_available": GPU_AVAILABLE,
        "active_device_default": "gpu:0" if GPU_AVAILABLE else "cpu",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }

from pydantic import BaseModel, ConfigDict, Field

class PipelineConfig(BaseModel):
    type: str = Field("docling_pdf", description="Pipeline to run: 'all', 'docling', 'docling_pdf', 'docling_images', or 'paddleocr'")

class DeviceConfig(BaseModel):
    type: str = Field("cpu", description="Device to use, e.g. cpu, gpu:0")

class ConvertedImage(BaseModel):
    model_config = ConfigDict(frozen=True)

    filename: str
    media_type: str = "image/png"
    data_url: str

class ConvertedImagesResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    pages: int
    images: list[ConvertedImage]

def encode_image(image_path: str) -> str:
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode("utf-8")

@app.post("/convert/images")
async def convert_images(file: UploadFile = File(...), dpi: int = Form(150)) -> ConvertedImagesResponse:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a PDF.")
    if dpi < 1:
        raise HTTPException(status_code=400, detail="dpi must be greater than zero.")

    with tempfile.TemporaryDirectory() as task_dir:
        source_path = os.path.join(task_dir, "document.pdf")
        output_dir = os.path.join(task_dir, "images")
        with open(source_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        image_paths = await run_in_threadpool(convert_pdf_to_images, source_path, output_dir, dpi)
        images = [
            ConvertedImage(
                filename=os.path.basename(image_path),
                data_url=f"data:image/png;base64,{encode_image(image_path)}",
            )
            for image_path in image_paths
        ]

    return ConvertedImagesResponse(pages=len(images), images=images)

def parse_pipeline(pipeline_val: str) -> str:
    try:
        data = json.loads(pipeline_val)
        if isinstance(data, dict) and "type" in data:
            return data["type"]
    except Exception:
        pass
    return pipeline_val

def parse_device(device_val: Optional[str]) -> Optional[str]:
    if not device_val:
        return None
    try:
        data = json.loads(device_val)
        if isinstance(data, dict) and "type" in data:
            return data["type"]
    except Exception:
        pass
    return device_val

# Create Ingestion Task Endpoint
@app.post("/tasks", status_code=202)
async def create_task(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    dpi: int = Form(150),
    pipeline: str = Form("docling_pdf"),
    device: Optional[str] = Form(None)
):
    # Parse potential JSON strings into values
    pipeline = parse_pipeline(pipeline)
    device = parse_device(device)

    # Validate inputs
    if not file and not url:
        raise HTTPException(status_code=400, detail="Must provide either 'file' upload or 'url' path.")
    if file and url:
        raise HTTPException(status_code=400, detail="Provide either 'file' or 'url', not both.")
    if pipeline not in ["all", "docling", "docling_pdf", "docling_images", "paddleocr"]:
        raise HTTPException(status_code=400, detail="Invalid pipeline. Choose 'all', 'docling', 'docling_pdf', 'docling_images', or 'paddleocr'.")
        
    # Resolve default device
    if not device:
        device = "gpu:0" if GPU_AVAILABLE else "cpu"
    else:
        if device.startswith("gpu") and not GPU_AVAILABLE:
            raise HTTPException(status_code=400, detail=f"GPU device '{device}' requested but CUDA is not available on this server.")
            
    # Generate unique Task ID
    task_id = str(uuid.uuid4())
    task_dir = os.path.join(DATA_DIR, task_id)
    os.makedirs(task_dir, exist_ok=True)
    
    # Save input source
    source_filename = "document.pdf"
    if file:
        if not file.filename.lower().endswith(".pdf"):
            shutil.rmtree(task_dir)
            raise HTTPException(status_code=400, detail="Uploaded file must be a PDF.")
        source_filename = file.filename
        source_path = os.path.join(task_dir, source_filename)
        try:
            with open(source_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
        except Exception as e:
            shutil.rmtree(task_dir)
            raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {e}")
    else:
        # Resolve filename from URL if possible
        url_clean = url.split("?")[0]
        name_part = url_clean.split("/")[-1]
        if name_part.lower().endswith(".pdf"):
            source_filename = name_part
        source_path = os.path.join(task_dir, source_filename)
        try:
            await run_in_threadpool(download_url_sync, url, source_path)
        except Exception as e:
            shutil.rmtree(task_dir)
            raise HTTPException(status_code=400, detail=f"Failed to download remote URL: {str(e)}")

    # Initial metadata
    metadata = {
        "task_id": task_id,
        "status": "pending",
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "params": {
            "dpi": dpi,
            "pipeline": pipeline,
            "device": device,
            "source_name": source_filename
        },
        "stats": {},
        "error": None
    }
    save_metadata(task_id, metadata)
    
    # Run the background task
    background_tasks.add_task(
        run_extraction_task,
        task_id=task_id,
        source_path=source_path,
        dpi=dpi,
        pipeline=pipeline,
        device=device
    )
    
    return {
        "task_id": task_id,
        "status": "pending",
        "created_at": metadata["created_at"]
    }

# Get Task Status Endpoint
@app.get("/tasks/{task_id}")
async def get_task_status(task_id: str):
    return load_metadata(task_id)

# Get Report Preview Endpoint
@app.get("/tasks/{task_id}/report")
async def get_task_report(task_id: str):
    metadata = load_metadata(task_id)
    if metadata["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Task is in status '{metadata['status']}' and report is not ready.")
        
    task_dir = os.path.join(DATA_DIR, task_id)
    output_dir = os.path.join(task_dir, "output")
    
    # Locate report file
    report_path = None
    if os.path.exists(output_dir):
        for entry in os.listdir(output_dir):
            entry_path = os.path.join(output_dir, entry)
            if os.path.isdir(entry_path):
                r_file = os.path.join(entry_path, "comparison_report.md")
                if os.path.exists(r_file):
                    report_path = r_file
                    break
                    
    if not report_path or not os.path.exists(report_path):
        raise HTTPException(status_code=404, detail="Comparison report file not found. It may not have been generated for single-pipeline runs.")
        
    return FileResponse(report_path, media_type="text/markdown", filename="comparison_report.md")

# Download Task ZIP Endpoint
@app.get("/tasks/{task_id}/download")
async def download_task_zip(task_id: str):
    metadata = load_metadata(task_id)
    if metadata["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Task is in status '{metadata['status']}' and output archive is not ready.")
        
    task_dir = os.path.join(DATA_DIR, task_id)
    output_dir = os.path.join(task_dir, "output")
    zip_path = os.path.join(task_dir, f"{task_id}.zip")
    
    if not os.path.exists(zip_path):
        if not os.path.exists(output_dir) or not os.listdir(output_dir):
            raise HTTPException(status_code=404, detail="Task output directory is empty or missing.")
        try:
            # Create zip file of output directory
            await run_in_threadpool(shutil.make_archive, zip_path.replace(".zip", ""), 'zip', output_dir)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to generate output ZIP: {e}")
            
    return FileResponse(zip_path, media_type="application/zip", filename=f"extraction_results_{task_id[:8]}.zip")



# Direct Markdown Retrieval Endpoint
@app.get("/tasks/{task_id}/markdown")
async def get_task_markdown(task_id: str, pipeline: Optional[str] = None):
    metadata = load_metadata(task_id)
    if metadata["status"] != "completed":
        raise HTTPException(status_code=400, detail=f"Task is in status '{metadata['status']}' and markdown is not ready.")
        
    task_dir = os.path.join(DATA_DIR, task_id)
    output_dir = os.path.join(task_dir, "output")
    
    # Locate output subdirectory (named after the PDF file)
    pdf_base_dir = None
    if os.path.exists(output_dir):
        for entry in os.listdir(output_dir):
            entry_path = os.path.join(output_dir, entry)
            if os.path.isdir(entry_path):
                pdf_base_dir = entry_path
                break
                
    if not pdf_base_dir:
        raise HTTPException(status_code=404, detail="Task output directory not found.")
        
    docling_pdf_path = os.path.join(pdf_base_dir, "docling_pdf", "document.md")
    docling_img_dir = os.path.join(pdf_base_dir, "docling_images")
    paddle_img_dir = os.path.join(pdf_base_dir, "paddleocr_images")
    
    # If a specific pipeline was requested, try to serve that
    if pipeline:
        if pipeline == "docling_pdf":
            if os.path.exists(docling_pdf_path):
                return FileResponse(docling_pdf_path, media_type="text/markdown", filename="document.md")
            else:
                raise HTTPException(status_code=404, detail="Docling PDF direct markdown not found for this task.")
                
        elif pipeline == "docling_images":
            if os.path.exists(docling_img_dir) and os.listdir(docling_img_dir):
                pages = sorted([f for f in os.listdir(docling_img_dir) if f.startswith("page_") and f.endswith(".md")])
                if not pages:
                    raise HTTPException(status_code=404, detail="No Docling image page markdown files found.")
                
                content_parts = []
                for p in pages:
                    with open(os.path.join(docling_img_dir, p), "r", encoding="utf-8") as f:
                        content_parts.append(f.read())
                return Response(content="\n\n".join(content_parts), media_type="text/markdown")
            else:
                raise HTTPException(status_code=404, detail="Docling Images markdown not found for this task.")
                
        elif pipeline == "paddleocr":
            if os.path.exists(paddle_img_dir) and os.listdir(paddle_img_dir):
                page_dirs = sorted([d for d in os.listdir(paddle_img_dir) if d.startswith("page_") and os.path.isdir(os.path.join(paddle_img_dir, d))])
                if not page_dirs:
                    raise HTTPException(status_code=404, detail="No PaddleOCR page directories found.")
                
                content_parts = []
                for p_dir in page_dirs:
                    md_file = os.path.join(paddle_img_dir, p_dir, f"{p_dir}.md")
                    if os.path.exists(md_file):
                        with open(md_file, "r", encoding="utf-8") as f:
                            content_parts.append(f.read())
                if not content_parts:
                    raise HTTPException(status_code=404, detail="No PaddleOCR markdown files found.")
                return Response(content="\n\n".join(content_parts), media_type="text/markdown")
            else:
                raise HTTPException(status_code=404, detail="PaddleOCR markdown not found for this task.")
        else:
            raise HTTPException(status_code=400, detail="Invalid pipeline query parameter. Use 'docling_pdf', 'docling_images', or 'paddleocr'.")
            
    # Auto-detect best available markdown
    if os.path.exists(docling_pdf_path):
        return FileResponse(docling_pdf_path, media_type="text/markdown", filename="document.md")
        
    if os.path.exists(docling_img_dir) and os.listdir(docling_img_dir):
        pages = sorted([f for f in os.listdir(docling_img_dir) if f.startswith("page_") and f.endswith(".md")])
        if pages:
            content_parts = []
            for p in pages:
                with open(os.path.join(docling_img_dir, p), "r", encoding="utf-8") as f:
                    content_parts.append(f.read())
            return Response(content="\n\n".join(content_parts), media_type="text/markdown")
            
    if os.path.exists(paddle_img_dir) and os.listdir(paddle_img_dir):
        page_dirs = sorted([d for d in os.listdir(paddle_img_dir) if d.startswith("page_") and os.path.isdir(os.path.join(paddle_img_dir, d))])
        if page_dirs:
            content_parts = []
            for p_dir in page_dirs:
                md_file = os.path.join(paddle_img_dir, p_dir, f"{p_dir}.md")
                if os.path.exists(md_file):
                    with open(md_file, "r", encoding="utf-8") as f:
                        content_parts.append(f.read())
            if content_parts:
                return Response(content="\n\n".join(content_parts), media_type="text/markdown")
                
    raise HTTPException(status_code=404, detail="No markdown output files found for this task.")


# Custom OpenAPI schema overrides
from fastapi.openapi.utils import get_openapi

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    
    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    
    # Ensure components and schemas exist
    if "components" not in openapi_schema:
        openapi_schema["components"] = {}
    if "schemas" not in openapi_schema["components"]:
        openapi_schema["components"]["schemas"] = {}
        
    # Inject PipelineConfig and DeviceConfig schemas
    openapi_schema["components"]["schemas"]["PipelineConfig"] = {
        "title": "PipelineConfig",
        "type": "object",
        "properties": {
            "type": {
                "title": "Type",
                "type": "string",
                "enum": ["all", "docling", "docling_pdf", "docling_images", "paddleocr"],
                "default": "docling_pdf",
                "description": "Which pipeline step to run"
            }
        }
    }
    
    openapi_schema["components"]["schemas"]["DeviceConfig"] = {
        "title": "DeviceConfig",
        "type": "object",
        "properties": {
            "type": {
                "title": "Type",
                "type": "string",
                "default": "cpu",
                "description": "Device to use, e.g. cpu, gpu:0"
            }
        }
    }
    
    # Update requestBody for create_task_tasks_post (/tasks POST)
    try:
        body_schema = openapi_schema.get("components", {}).get("schemas", {}).get("Body_create_task_tasks_post", {})
        properties = body_schema.get("properties", {})
        
        if "pipeline" in properties:
            properties["pipeline"] = {
                "$ref": "#/components/schemas/PipelineConfig"
            }
        if "device" in properties:
            properties["device"] = {
                "$ref": "#/components/schemas/DeviceConfig"
            }
    except Exception as e:
        print(f"Error customizing OpenAPI schema: {e}")
        
    app.openapi_schema = openapi_schema
    return app.openapi_schema

app.openapi = custom_openapi
