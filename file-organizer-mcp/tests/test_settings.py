import pytest
from file_organizer_mcp.settings import Settings


def test_extension_normalization():
    assert Settings.normalize_extension("PDF") == ".pdf"
    assert Settings.normalize_extension(".PDF") == ".pdf"


def test_glob_is_rejected():
    with pytest.raises(ValueError):
        Settings.normalize_extension("*.pdf")


def test_invalid_chunk_overlap():
    with pytest.raises(ValueError):
        Settings(chunk_tokens=100, chunk_overlap=100, n_ctx=256)
