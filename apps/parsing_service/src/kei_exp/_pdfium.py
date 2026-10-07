"""The process-wide PDFium lock, Docling's own when it is installed: PDFium calls on different documents are not
independent. Hold it for opening, reading, rendering and closing native handles; release it before layout, OCR,
network calls and image-file I/O. Non-reentrant: a locked operation must not call another locking one."""
from threading import Lock

try:
    from docling.utils.locks import pypdfium2_lock as pdfium_lock
except ModuleNotFoundError as error:
    if error.name != "docling":
        raise
    pdfium_lock = Lock()
