from __future__ import annotations
import os
from pathlib import Path
from typing import Literal
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore", env_ignore_empty=True,)

    mcp_server_name: str = "file-organizer-bertopic"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8000
    mcp_path: str = "/mcp"
    log_level: str = "INFO"

    recursive: bool = False
    supported_extensions: str = ".pdf,.txt,.md,.docx,.json,.html,.htm,.xml,.pptx,.epub,.xlsx"
    max_files_per_request: int = 1000
    max_file_size_mb: int = 100
    min_extracted_characters: int = 40

    embedding_model_path: Path = Path("nomic-embed-text-v1.5.Q6_K.gguf")
    embedding_task_prefix: str = "clustering:"
    n_ctx: int = 2048
    batch_size: int = 512
    gpu_layers: int = -1
    threads: int | None = None

    chunk_tokens: int = 1024
    chunk_overlap: int = 128
    max_chunks_per_file: int = 12
    max_pages: int = 0
    ctfidf_max_chars: int = 100000

    min_topic_size: int = 3
    min_df: int = 1
    max_df: float = 1.0
    top_terms: int = 10
    language: str = "english"
    ngram_min: int = 1
    ngram_max: int = 2
    umap_n_neighbors: int | Literal["auto"] = "auto"
    umap_n_components: int | Literal["auto"] = "auto"
    umap_min_dist: float = 0.0
    umap_metric: str = "cosine"
    umap_random_state: int = 42
    hdbscan_min_cluster_size: int | Literal["auto"] = "auto"
    hdbscan_metric: str = "euclidean"
    hdbscan_cluster_selection_method: str = "eom"
    hdbscan_prediction_data: bool = True
    calculate_probabilities: bool = True
    ctfidf_bm25_weighting: bool = True
    ctfidf_reduce_frequent_words: bool = True

    cache_enabled: bool = True
    cache_dir: Path = Path("./cache/embeddings")
    cache_expiration_days: int = 30
    cache_cleanup_interval_hours: int = 24
    force_reembed: bool = False

    result_ttl_minutes: int = 30
    max_stored_runs: int = 20

    max_queued_jobs: int = 5
    queue_wait_timeout_seconds: float = 1800
    request_processing_timeout_seconds: float = 3600

    @field_validator("mcp_path")
    @classmethod
    def normalize_path(cls, value: str) -> str:
        return "/" + value.strip("/")

    @model_validator(mode="after")
    def validate_combinations(self):
        if self.chunk_overlap < 0 or self.chunk_overlap >= self.chunk_tokens:
            raise ValueError("CHUNK_OVERLAP must be >= 0 and smaller than CHUNK_TOKENS")
        if self.chunk_tokens + 16 > self.n_ctx:
            raise ValueError("CHUNK_TOKENS plus prefix headroom must not exceed N_CTX")
        if self.ngram_min < 1 or self.ngram_min > self.ngram_max:
            raise ValueError("NGRAM_MIN must be >= 1 and <= NGRAM_MAX")
        if self.max_queued_jobs < 0:
            raise ValueError("MAX_QUEUED_JOBS cannot be negative")
        if self.threads is None:
            self.threads = max(1, (os.cpu_count() or 4) // 2)
        self.embedding_model_path = self.embedding_model_path.expanduser().resolve()
        self.cache_dir = self.cache_dir.expanduser().resolve()
        return self

    @property
    def extension_allowlist(self) -> set[str]:
        return {self.normalize_extension(x) for x in self.supported_extensions.split(",") if x.strip()}

    @staticmethod
    def normalize_extension(value: str) -> str:
        value = value.strip().lower()
        if not value.startswith("."):
            value = "." + value
        if any(c in value for c in "*?[]/") or chr(92) in value or value.count(".") != 1 or len(value) < 2:
            raise ValueError(f"Invalid extension suffix: {value!r}")
        return value
