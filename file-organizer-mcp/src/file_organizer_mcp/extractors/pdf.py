from __future__ import annotations
from pathlib import Path
from pypdf import PdfReader
from .common import clean_text, extraction_failure


class PdfExtractor:
    name = "pypdf"
    version = "2"

    def extract(self, path: Path, max_pages: int):
        try:
            reader = PdfReader(str(path), strict=False)
            pages = reader.pages if max_pages <= 0 else reader.pages[:max_pages]
            parts: list[str] = []
            warnings: list[str] = []
            for number, page in enumerate(pages, 1):
                try:
                    parts.append(page.extract_text() or "")
                except Exception as exc:
                    warnings.append(f"Page {number}: {exc}")
            text = clean_text("\n".join(parts))
            metadata = {"page_count": len(reader.pages), "pages_extracted": len(pages), "extraction_warnings": warnings}
            if not text:
                return "", metadata, extraction_failure("NO_EXTRACTABLE_TEXT", "No extractable text was found; the PDF may be scanned.")
            return text, metadata, None
        except Exception as exc:
            return "", {"page_count": 0, "pages_extracted": 0, "extraction_warnings": []}, extraction_failure("PDF_EXTRACTION_FAILED", str(exc))
