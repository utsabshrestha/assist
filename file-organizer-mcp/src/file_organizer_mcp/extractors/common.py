from __future__ import annotations
import re


def clean_text(text: str) -> str:
    text = text.replace("\x00", " ")
    text = re.sub(r"(?<=\w)-\s*\n\s*(?=\w)", "", text)
    return re.sub(r"\s+", " ", text).strip()


def extraction_failure(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}
