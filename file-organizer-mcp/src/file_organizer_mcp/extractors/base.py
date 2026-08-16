from __future__ import annotations
from pathlib import Path
from typing import Protocol

ExtractionMetadata = dict[str, object]
ExtractionError = dict[str, str] | None
ExtractionResult = tuple[str, ExtractionMetadata, ExtractionError]


class DocumentExtractor(Protocol):
    name: str
    version: str

    def extract(self, path: Path, max_pages: int) -> ExtractionResult:
        """Extract normalized text. max_pages is format-specific where applicable."""
        ...
