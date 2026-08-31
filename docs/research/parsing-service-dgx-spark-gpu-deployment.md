# Parsing Service GPU deployment on NVIDIA DGX Spark

Research snapshot: 2026-08-31. Sources are first-party NVIDIA, Docker,
Docling, PyTorch, and repository sources.

## Conclusion

FREE can run its existing Parsing Service image on the deployment machine's
NVIDIA DGX Spark GPU without installing another host driver or changing to an
NVIDIA base image. Stock DGX Spark already includes Docker, the NVIDIA
Container Runtime, and the NVIDIA Container Toolkit; the service needs only
GPU device exposure through Compose and `DOCLING_DEVICE=cuda`. [1][2][3]

Build the image on Spark itself. Spark is ARM64 with an integrated Blackwell GPU
and 128 GB unified memory, while the repository's current lock contains an
ARM64 CPython 3.13 PyTorch wheel and ARM64 CUDA 13 user-space wheels. [4][5][6]

## Exact deployment path

1. Verify the stock host runtime before changing FREE:

   ```bash
   nvidia-smi
   nvidia-ctk --version
   docker run --rm --gpus=all \
     nvcr.io/nvidia/cuda:13.0.1-devel-ubuntu24.04 nvidia-smi
   ```

   NVIDIA documents the last command as DGX Spark's container GPU validation.
   If it fails, repair or update the host runtime first; FREE configuration
   cannot compensate for an unavailable NVIDIA runtime. [2]

2. Set Docling's inference device in the ignored root `.env`:

   ```dotenv
   DOCLING_DEVICE=cuda
   ```

   Docling defines `cuda` as its NVIDIA inference device and reads the choice
   from `DOCLING_DEVICE`. The current FREE adapter constructs the standard
   `DocumentConverter`, so the environment setting reaches the default
   accelerator options without an application-code change. [3][7]

3. Enable the already documented reservation under
   `services.parsing_service` in `compose.prod.yaml`:

   ```yaml
   deploy:
     resources:
       reservations:
         devices:
           - driver: nvidia
             count: all
             capabilities: [gpu]
   ```

   Docker requires `capabilities`; `count: all` exposes Spark's one integrated
   GPU and avoids inventing a machine-specific device ID. [1]

4. Start the normal production path:

   ```bash
   node scripts/free.mjs production
   ```

   The launcher already builds on the deployment host and invokes the two
   production Compose files with `up --build -d --wait`; no parallel Spark-only
   launcher is needed. [8]

## Verification

First prove that the actual service environment selected CUDA and can execute a
CUDA operation, not merely enumerate a device:

```bash
docker compose -f compose.yaml -f compose.prod.yaml exec parsing_service \
  uv run --no-sync python -c \
  "import os, torch; assert os.environ['DOCLING_DEVICE'] == 'cuda'; assert torch.cuda.is_available(); x = torch.ones(1, device='cuda'); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0), x)"
```

`torch.cuda.is_available()` is PyTorch's official CUDA availability check; the
tensor allocation also forces real CUDA work. [9]

Then run the repository's smallest end-to-end Docling check:

```bash
docker compose -f compose.yaml -f compose.prod.yaml exec \
  -e RUN_DOCLING_SMOKE=1 parsing_service \
  uv run --no-sync python -m unittest discover -s tests \
  -p test_docling_smoke.py
```

This converts the checked-in one-page PDF fixture through the real reusable
`DocumentConverter` and validates a `parsed_document.v2` result. [10]

Do not use the Parsing Service `/status` response to verify GPU use: its
`gpu_available` and `active_device_default` fields are currently constants
(`false` and `null`) rather than runtime probes. [11]

## Compatibility and failure boundaries

- The locked `torch 2.13.0` has a CPython 3.13
  `manylinux_2_28_aarch64` wheel, and the lock includes ARM64 CUDA 13
  dependencies. This makes a native Spark build plausible without lock-file or
  Dockerfile changes; the two runtime checks above remain the proof. [5]
- DGX Spark's current Founders Edition release reports driver `580.159.03` and
  CUDA Toolkit `13.0.2`. Partner GB10 systems can lag, so inspect the actual
  machine rather than assuming those versions. [6]
- NVIDIA documents Spark compute capability 12.1 and requires CUDA Toolkit 13.0
  or later for native Blackwell support. The lock's CUDA 13 generation is the
  right family. [12]
- CUDA 13.x minor-version compatibility requires a 580-or-newer driver, but
  newer-toolkit features or runtime-compiled PTX can still require a newer
  driver. If the CUDA tensor or Docling smoke check reports
  `cudaErrorCallRequiresNewerDriver` or PTX errors, update DGX OS through the
  supported Spark update path before changing Python dependencies. [6][13][14]
- On Spark's integrated GPU, `nvidia-smi` can report GPU memory usage as not
  supported because CPU and GPU share unified memory. NVIDIA lists this as a
  known behavior, not proof that CUDA is unavailable. [15]
- Keep Docling's default batching initially. Its GPU guide exposes further
  concurrency and batch-size tuning, but those values should follow a measured
  Parsing Service bottleneck rather than become deployment prerequisites. [16]

## Sources

1. [Docker: Run Docker Compose services with GPU access](https://docs.docker.com/compose/how-tos/gpu-support/)
2. [NVIDIA: Container Runtime for Docker on DGX Spark](https://docs.nvidia.com/dgx/dgx-spark/nvidia-container-runtime-for-docker.html)
3. [Docling: Accelerator options](https://docling-project.github.io/docling/reference/pipeline_options/#docling.datamodel.accelerator_options.AcceleratorOptions)
4. [NVIDIA: DGX Spark system overview](https://docs.nvidia.com/dgx/dgx-spark/system-overview.html)
5. [FREE Parsing Service lock](../../prototypes/parsing_service/uv.lock)
6. [NVIDIA: DGX Spark release notes](https://docs.nvidia.com/dgx/dgx-spark/release-notes.html)
7. [FREE Docling adapter](../../prototypes/parsing_service/app/docling_parser.py)
8. [FREE production launcher](../../scripts/free.mjs)
9. [PyTorch: `torch.cuda.is_available`](https://docs.pytorch.org/docs/stable/generated/torch.cuda.is_available)
10. [FREE live Docling smoke test](../../prototypes/parsing_service/tests/test_docling_smoke.py)
11. [FREE Parsing Service status implementation](../../prototypes/parsing_service/app/main.py)
12. [NVIDIA: Porting CUDA to DGX Spark](https://docs.nvidia.com/dgx/dgx-spark-porting-guide/porting/compilation.html)
13. [NVIDIA: CUDA minor-version compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)
14. [NVIDIA: DGX Spark OS and component update](https://docs.nvidia.com/dgx/dgx-spark/os-and-component-update.html)
15. [NVIDIA: DGX Spark known issues](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html)
16. [Docling: GPU support](https://docling-project.github.io/docling/usage/gpu/)
