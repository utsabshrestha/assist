from __future__ import annotations
from pathlib import Path
from .common import clean_text, extraction_failure


class PlainTextExtractor:
    name = "plain-text"
    version = "1"

    def extract(self, path: Path, max_pages: int):
        del max_pages
        try:
            raw = path.read_bytes()
            encoding = "utf-8"
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                encoding = "utf-8-replacement"
                text = raw.decode("utf-8", errors="replace")
            text = clean_text(text)
            if not text:
                return "", {"encoding": encoding}, extraction_failure("NO_EXTRACTABLE_TEXT", "The file contains no extractable text.")
            return text, {"encoding": encoding}, None
        except Exception as exc:
            return "", {}, extraction_failure("TEXT_EXTRACTION_FAILED", str(exc))
