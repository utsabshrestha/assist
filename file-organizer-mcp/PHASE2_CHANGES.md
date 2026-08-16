# Phase 2 document extraction changes

## Newly supported formats

- `.txt` and `.md`: UTF-8 text extraction
- `.json`: parsed JSON rendered with keys and values retained
- `.html` and `.htm`: visible text; scripts, styles, templates, and noscript nodes removed
- `.xml`: safe XML parsing with element names and text retained
- `.docx`: paragraphs, tables, headers, and footers
- `.pptx`: slide text, tables, and speaker notes; `MAX_PAGES` acts as a slide limit
- `.epub`: XHTML chapter text; `MAX_PAGES` acts as a chapter/document-item limit
- `.pdf`: existing page-based extraction remains supported

Legacy `.doc` and `.ppt` are intentionally unsupported.

## Files changed

Updated:
- `.env.example`
- `pyproject.toml`
- `requirements.txt`
- `src/file_organizer_mcp/__init__.py`
- `src/file_organizer_mcp/clustering.py`
- `src/file_organizer_mcp/discovery.py`
- `src/file_organizer_mcp/extractors/__init__.py`
- `src/file_organizer_mcp/extractors/pdf.py`
- `src/file_organizer_mcp/schemas.py`
- `src/file_organizer_mcp/server.py`
- `src/file_organizer_mcp/settings.py`

Added:
- `src/file_organizer_mcp/extractors/base.py`
- `src/file_organizer_mcp/extractors/common.py`
- `src/file_organizer_mcp/extractors/plain_text.py`
- `src/file_organizer_mcp/extractors/json_document.py`
- `src/file_organizer_mcp/extractors/markup.py`
- `src/file_organizer_mcp/extractors/docx_document.py`
- `src/file_organizer_mcp/extractors/pptx_document.py`
- `src/file_organizer_mcp/extractors/epub_document.py`
- `tests/test_extractors.py`

## Apply to an existing checkout

Copy the supplied files into the same relative paths, then run:

```bash
source .venv/bin/activate
python -m pip install -e .
pytest
```

Restart the MCP server after updating dependencies and `.env`.
