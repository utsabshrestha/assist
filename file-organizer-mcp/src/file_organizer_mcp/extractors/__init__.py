from __future__ import annotations
from .base import DocumentExtractor
from .docx_document import DocxExtractor
from .epub_document import EpubExtractor
from .json_document import JsonExtractor
from .markup import HtmlExtractor, XmlExtractor
from .pdf import PdfExtractor
from .plain_text import PlainTextExtractor
from .pptx_document import PptxExtractor
from .xlsx_document import XlsxExtractor


def build_extractor_registry() -> dict[str, DocumentExtractor]:
    plain = PlainTextExtractor()
    html = HtmlExtractor()
    return {
        ".pdf": PdfExtractor(),
        ".txt": plain,
        ".md": plain,
        ".json": JsonExtractor(),
        ".html": html,
        ".htm": html,
        ".xml": XmlExtractor(),
        ".docx": DocxExtractor(),
        ".pptx": PptxExtractor(),
        ".xlsx": XlsxExtractor(),
        ".epub": EpubExtractor(),
    }


__all__ = ["DocumentExtractor", "build_extractor_registry"]
