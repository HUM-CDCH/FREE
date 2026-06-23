import os
import urllib.request
import pypdfium2 as pdfium
from PIL import Image

def download_file(url: str, dest_path: str):
    """Downloads a file from a URL to dest_path with user-agent header."""
    print(f"Downloading {url} to {dest_path}...")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as response, open(dest_path, 'wb') as out_file:
        out_file.write(response.read())

def convert_pdf_to_images(pdf_path: str, output_dir: str, dpi: int = 150) -> list[str]:
    """
    Converts a PDF file into a sequence of PNG images (one per page).
    
    Args:
        pdf_path: Path to the input PDF file.
        output_dir: Directory where the output images will be saved.
        dpi: Dots Per Inch for rendering resolution (default 150).
        
    Returns:
        List of absolute file paths to the generated images.
    """
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")
        
    os.makedirs(output_dir, exist_ok=True)
    scale = dpi / 72.0
    
    pdf = pdfium.PdfDocument(pdf_path)
    image_paths = []
    
    try:
        for i in range(len(pdf)):
            page = pdf.get_page(i)
            # Render page to a PIL image with white background
            bitmap = page.render(
                scale=scale,
                rotation=0,
                fill_color=(255, 255, 255, 255)
            )
            pil_image = bitmap.to_pil()
            
            # Format filename, e.g., page_01.png, page_02.png
            filename = f"page_{i+1:02d}.png"
            image_path = os.path.join(output_dir, filename)
            pil_image.save(image_path)
            image_paths.append(os.path.abspath(image_path))
    finally:
        pdf.close()
        
    return image_paths
