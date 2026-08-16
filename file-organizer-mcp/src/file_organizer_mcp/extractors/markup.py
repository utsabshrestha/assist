from __future__ import annotations
from pathlib import Path
from bs4 import BeautifulSoup
from defusedxml import ElementTree as SafeET
from .common import clean_text, extraction_failure


class HtmlExtractor:
    name = "beautifulsoup-html"
    version = "1"

    def extract(self, path: Path, max_pages: int):
        del max_pages
        try:
            raw = path.read_bytes()
            soup = BeautifulSoup(raw, "html.parser")
            for node in soup(["script", "style", "noscript", "template"]):
                node.decompose()
            text = clean_text(soup.get_text(" "))
            if not text:
                return "", {}, extraction_failure("NO_EXTRACTABLE_TEXT", "The HTML document contains no visible text.")
            return text, {"title": clean_text(soup.title.get_text(" ")) if soup.title else None}, None
        except Exception as exc:
            return "", {}, extraction_failure("HTML_EXTRACTION_FAILED", str(exc))


class XmlExtractor:
    name = "defusedxml"
    version = "1"

    def extract(self, path: Path, max_pages: int):
        del max_pages
        try:
            root = SafeET.parse(path).getroot()
            # Include element names as lightweight structural context, plus text/tails.
            parts: list[str] = []
            for element in root.iter():
                tag = str(element.tag).split("}")[-1]
                if tag:
                    parts.append(tag)
                if element.text:
                    parts.append(element.text)
                if element.tail:
                    parts.append(element.tail)
            text = clean_text(" ".join(parts))
            if not text:
                return "", {"root_tag": str(root.tag)}, extraction_failure("NO_EXTRACTABLE_TEXT", "The XML document contains no extractable text.")
            return text, {"root_tag": str(root.tag)}, None
        except Exception as exc:
            return "", {}, extraction_failure("XML_EXTRACTION_FAILED", str(exc))
