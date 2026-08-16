from __future__ import annotations
import hashlib
from pathlib import Path
import numpy as np
from llama_cpp import Llama
from .settings import Settings


def model_fingerprint(path: Path) -> str:
    stat = path.stat()
    payload = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
    return hashlib.sha256(payload.encode()).hexdigest()


def l2_normalize(x: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(x)
    return x / norm if norm else x


class Embedder:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.llm = Llama(
            model_path=str(settings.embedding_model_path), embedding=True,
            n_ctx=settings.n_ctx, n_batch=min(settings.batch_size, settings.n_ctx),
            n_threads=settings.threads, n_gpu_layers=settings.gpu_layers, verbose=False,
        )

    def _chunks(self, text: str) -> list[list[int]]:
        s = self.settings
        tokens = self.llm.tokenize(text.encode("utf-8"), add_bos=False, special=False)
        step = s.chunk_tokens - s.chunk_overlap
        chunks = [tokens[i:i+s.chunk_tokens] for i in range(0, len(tokens), step) if tokens[i:i+s.chunk_tokens]]
        if s.max_chunks_per_file > 0 and len(chunks) > s.max_chunks_per_file:
            indices = np.linspace(0, len(chunks)-1, s.max_chunks_per_file, dtype=int)
            chunks = [chunks[i] for i in sorted(set(indices.tolist()))]
        return chunks

    def embed(self, text: str) -> tuple[np.ndarray, int, int]:
        chunks = self._chunks(text)
        vectors = []
        token_count = 0
        for token_ids in chunks:
            body = self.llm.detokenize(token_ids).decode("utf-8", errors="ignore")
            result = self.llm.create_embedding(f"{self.settings.embedding_task_prefix} {body}")
            vectors.append(np.asarray(result["data"][0]["embedding"], dtype=np.float32))
            token_count += len(token_ids)
        if not vectors:
            raise ValueError("No embedding chunks were produced")
        return l2_normalize(np.mean(vectors, axis=0)), len(chunks), token_count
