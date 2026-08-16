from __future__ import annotations
import json
from pathlib import Path
from .common import clean_text, extraction_failure


class JsonExtractor:
    name = "python-json"
    version = "1"

    def extract(self, path: Path, max_pages: int):
        del max_pages
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            # Retain keys and scalar values while normalizing formatting.
            text = clean_text(json.dumps(data, ensure_ascii=False, indent=2))
            if not text:
                return "", {}, extraction_failure("NO_EXTRACTABLE_TEXT", "The JSON document contains no extractable content.")
            return text, {"root_type": type(data).__name__}, None
        except UnicodeDecodeError as exc:
            return "", {}, extraction_failure("JSON_ENCODING_FAILED", str(exc))
        except json.JSONDecodeError as exc:
            return "", {}, extraction_failure("INVALID_JSON", str(exc))
        except Exception as exc:
            return "", {}, extraction_failure("JSON_EXTRACTION_FAILED", str(exc))
