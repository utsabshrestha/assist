from file_organizer_mcp.discovery import discover, validate_extensions
from file_organizer_mcp.settings import Settings


def test_case_insensitive_pdf_discovery(tmp_path):
    (tmp_path / "one.PDF").write_bytes(b"x")
    (tmp_path / "two.txt").write_text("x")
    settings = Settings(embedding_model_path=tmp_path / "unused.gguf")
    exts = validate_extensions(["PDF"], settings)
    _, found = discover(str(tmp_path), exts, settings)
    assert [p.name for p in found] == ["one.PDF"]
