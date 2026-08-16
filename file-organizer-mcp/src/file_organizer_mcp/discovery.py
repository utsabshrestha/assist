from pathlib import Path
from .errors import OrganizerError
from .settings import Settings


def validate_extensions(values: list[str], settings: Settings) -> list[str]:
    try:
        normalized = sorted({settings.normalize_extension(v) for v in values})
    except ValueError as exc:
        raise OrganizerError("INVALID_EXTENSION", str(exc)) from exc
    unsupported = [x for x in normalized if x not in settings.extension_allowlist]
    if unsupported:
        raise OrganizerError("UNSUPPORTED_EXTENSION", f"Unsupported extension(s): {', '.join(unsupported)}. Supported: {', '.join(sorted(settings.extension_allowlist))}")
    return normalized


def discover(folder_value: str, extensions: list[str], settings: Settings) -> tuple[Path, list[Path]]:
    folder = Path(folder_value).expanduser().resolve()
    if not folder.exists():
        raise OrganizerError("FOLDER_NOT_FOUND", f"Folder does not exist: {folder}")
    if not folder.is_dir():
        raise OrganizerError("NOT_A_DIRECTORY", f"Path is not a directory: {folder}")
    iterator = folder.rglob("*") if settings.recursive else folder.glob("*")
    files = sorted(p for p in iterator if p.is_file() and p.suffix.lower() in extensions)
    if len(files) > settings.max_files_per_request:
        raise OrganizerError("TOO_MANY_FILES", f"Found {len(files)} files; maximum is {settings.max_files_per_request}.")
    return folder, files
