from __future__ import annotations
import hashlib
import time
from pathlib import Path
import joblib
from .settings import Settings

CACHE_SCHEMA_VERSION = 1


class EmbeddingCache:
    def __init__(self, settings: Settings, model_fingerprint: str):
        self.settings = settings
        self.model_fingerprint = model_fingerprint
        self.settings.cache_dir.mkdir(parents=True, exist_ok=True)

    def key(self, path: Path, extractor_name: str, extractor_version: str) -> str:
        stat = path.stat()
        s = self.settings
        payload = "|".join(map(str, [
            CACHE_SCHEMA_VERSION, path.resolve(), stat.st_size, stat.st_mtime_ns,
            self.model_fingerprint, extractor_name, extractor_version,
            s.embedding_task_prefix, s.chunk_tokens, s.chunk_overlap,
            s.max_chunks_per_file, s.max_pages, "mean_pool_l2_normalize_v1"
        ]))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def load(self, key: str):
        if not self.settings.cache_enabled or self.settings.force_reembed:
            return None
        path = self.settings.cache_dir / f"{key}.joblib"
        if not path.exists():
            return None
        max_age = self.settings.cache_expiration_days * 86400
        if max_age >= 0 and time.time() - path.stat().st_mtime > max_age:
            path.unlink(missing_ok=True)
            return None
        try:
            return joblib.load(path)
        except Exception:
            path.unlink(missing_ok=True)
            return None

    def save(self, key: str, value: dict) -> None:
        if not self.settings.cache_enabled:
            return
        target = self.settings.cache_dir / f"{key}.joblib"
        temporary = target.with_suffix(".tmp")
        joblib.dump(value, temporary)
        temporary.replace(target)

    def cleanup(self) -> int:
        if not self.settings.cache_enabled:
            return 0
        max_age = self.settings.cache_expiration_days * 86400
        if max_age < 0:
            return 0
        removed = 0
        now = time.time()
        for path in self.settings.cache_dir.glob("*.joblib"):
            try:
                if now - path.stat().st_mtime > max_age:
                    path.unlink()
                    removed += 1
            except FileNotFoundError:
                pass
        return removed
