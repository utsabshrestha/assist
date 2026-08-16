from __future__ import annotations
from pathlib import Path
from bs4 import BeautifulSoup
from ebooklib import epub, ITEM_DOCUMENT
from .common import clean_text, extraction_failure


class EpubExtractor:
    name = "ebooklib"
    version = "1"

    def extract(self, path: Path, max_pages: int):
        # For EPUB, MAX_PAGES is interpreted as maximum XHTML document/chapter items.
        try:
            book = epub.read_epub(str(path), options={"ignore_ncx": True})
            items = list(book.get_items_of_type(ITEM_DOCUMENT))
            selected = items if max_pages <= 0 else items[:max_pages]
            parts: list[str] = []
            for item in selected:
                soup = BeautifulSoup(item.get_content(), "html.parser")
                for node in soup(["script", "style", "noscript", "template"]):
                    node.decompose()
                value = clean_text(soup.get_text(" "))
                if value:
                    parts.append(value)
            text = clean_text("\n".join(parts))
            metadata = {"document_items": len(items), "document_items_extracted": len(selected)}
            if not text:
                return "", metadata, extraction_failure("NO_EXTRACTABLE_TEXT", "The EPUB file contains no extractable text.")
            return text, metadata, None
        except Exception as exc:
            return "", {}, extraction_failure("EPUB_EXTRACTION_FAILED", str(exc))
