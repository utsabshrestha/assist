from __future__ import annotations
import logging, time, uuid
from dataclasses import asdict
from pathlib import Path
import numpy as np
from bertopic import BERTopic
from bertopic.vectorizers import ClassTfidfTransformer
from hdbscan import HDBSCAN
from sklearn.feature_extraction.text import CountVectorizer
from umap import UMAP
from .cache import EmbeddingCache
from .discovery import discover, validate_extensions
from .embeddings import Embedder, model_fingerprint
from .extractors import build_extractor_registry
from .settings import Settings
from .tuning import ClusteringOverrides, Strategy, resolve_config

LOG = logging.getLogger(__name__)


def file_identity(path: Path, root: Path) -> dict:
    return {
        "name": path.name,
        "relative_path": str(path.relative_to(root)),
        "absolute_path": str(path),
        "extension": path.suffix.lower(),
    }


class ClusteringService:

    def __init__(self, settings: Settings):
        self.settings = settings
        if not settings.embedding_model_path.is_file():
            raise FileNotFoundError(
                f"GGUF model not found: {settings.embedding_model_path}"
            )
        LOG.info(
            "Loading embedding model once: %s", settings.embedding_model_path
        )
        self.embedder = Embedder(settings)
        self.cache = EmbeddingCache(
            settings, model_fingerprint(settings.embedding_model_path)
        )
        self.extractors = build_extractor_registry()
        self.expired_at_startup = self.cache.cleanup()

    def cluster_files(
        self,
        folder_path: str,
        extensions: list[str],
        strategy: Strategy = "auto",
        overrides: ClusteringOverrides | None = None,
        queue_wait: float = 0.0,
    ):
        extensions = validate_extensions(extensions, self.settings)
        root, files = discover(folder_path, extensions, self.settings)
        texts, vectors, records, skipped = [], [], [], []
        hits = misses = 0
        max_bytes = self.settings.max_file_size_mb * 1024 * 1024

        for index, path in enumerate(files, 1):
            LOG.info("[%d/%d] %s", index, len(files), path)
            record = file_identity(path, root)
            if path.stat().st_size > max_bytes:
                skipped.append(
                    {
                        **record,
                        "reason": {
                            "code": "FILE_TOO_LARGE",
                            "message": (
                                f"File exceeds"
                                f" {self.settings.max_file_size_mb} MB."
                            ),
                        },
                    }
                )
                continue
            extractor = self.extractors[path.suffix.lower()]
            text, _, error = extractor.extract(path, self.settings.max_pages)
            if error:
                skipped.append({**record, "reason": error})
                continue
            if len(text) < self.settings.min_extracted_characters:
                skipped.append(
                    {
                        **record,
                        "reason": {
                            "code": "INSUFFICIENT_TEXT",
                            "message": (
                                "Too little text was extracted for clustering."
                            ),
                        },
                    }
                )
                continue
            key = self.cache.key(path, extractor.name, extractor.version)
            cached = self.cache.load(key)
            try:
                if cached is None:
                    vector, chunks, tokens = self.embedder.embed(text)
                    self.cache.save(
                        key,
                        {
                            "embedding": vector,
                            "chunk_count": chunks,
                            "embedded_tokens": tokens,
                        },
                    )
                    misses += 1
                else:
                    vector = cached["embedding"]
                    hits += 1
                texts.append(text[: self.settings.ctfidf_max_chars])
                vectors.append(vector)
                records.append(record)
            except Exception as exc:
                LOG.exception("Embedding failed for %s", path)
                skipped.append(
                    {
                        **record,
                        "reason": {
                            "code": "EMBEDDING_FAILED",
                            "message": str(exc),
                        },
                    }
                )

        return self.cluster_prepared_texts(
            texts=texts,
            vectors=vectors,
            records=records,
            skipped=skipped,
            input_type="documents",
            member_key="files",
            strategy=strategy,
            overrides=overrides,
            queue_wait=queue_wait,
            request={
                "folder_path": str(root),
                "extensions": extensions,
                "recursive": self.settings.recursive,
            },
            cache_stats={
                "enabled": self.settings.cache_enabled,
                "hits": hits,
                "misses": misses,
            },
        )

    def cluster_prepared_texts(
        self,
        *,
        texts,
        vectors,
        records,
        skipped,
        input_type,
        member_key,
        strategy,
        overrides,
        queue_wait,
        request,
        cache_stats,
    ):
        """Shared BERTopic engine used by documents and image descriptions."""
        started = time.monotonic()
        request_id = str(uuid.uuid4())
        common = {
            "status": "failed" if skipped else "completed",
            "request_id": request_id,
            "input_type": input_type,
            "request": request,
            "skipped_items": skipped,
            "cache": cache_stats,
            "processing": {"queue_wait_seconds": round(queue_wait, 3)},
        }
        if not texts:
            return {
                **common,
                "status": "failed",
                "mode": "empty",
                "topics": [],
                "outliers": [],
                "effective_config": {},
                "adjustments": [],
                "warnings": [
                    {
                        "code": "NO_USABLE_ITEMS",
                        "message": (
                            "No usable items were available for clustering."
                        ),
                    }
                ],
            }
        embeddings = np.vstack(vectors).astype(np.float32)
        if len(texts) < 3:
            members = [
                {**record, "cluster_probability": None} for record in records
            ]
            topic = {
                "topic_id": 0,
                "document_count": len(records),
                "keywords": [],
                "mean_pairwise_cosine_similarity": self._cohesion(embeddings),
                member_key: members,
            }
            return {
                **common,
                "status": "failed",
                "mode": "small_collection_fallback",
                "topics": [topic],
                "outliers": [],
                "effective_config": {},
                "adjustments": [],
                "warnings": [
                    {
                        "code": "INSUFFICIENT_ITEMS_FOR_BERTOPIC",
                        "message": (
                            "Fewer than three usable items; BERTopic was not"
                            " run."
                        ),
                    }
                ],
            }

        cfg, adjustments = resolve_config(
            strategy, overrides, len(texts), self.settings
        )
        s = self.settings
        model = BERTopic(
            embedding_model=None,
            umap_model=UMAP(
                n_neighbors=cfg.umap_n_neighbors,
                n_components=cfg.umap_n_components,
                min_dist=s.umap_min_dist,
                metric=s.umap_metric,
                random_state=s.umap_random_state,
            ),
            hdbscan_model=HDBSCAN(
                min_cluster_size=cfg.hdbscan_min_cluster_size,
                metric=s.hdbscan_metric,
                cluster_selection_method=cfg.hdbscan_cluster_selection_method,
                prediction_data=True,
            ),
            vectorizer_model=CountVectorizer(
                stop_words=(
                    None if s.language.lower() == "none" else s.language
                ),
                ngram_range=(s.ngram_min, s.ngram_max),
                min_df=s.min_df,
                max_df=1.0,
            ),
            ctfidf_model=ClassTfidfTransformer(
                bm25_weighting=s.ctfidf_bm25_weighting,
                reduce_frequent_words=s.ctfidf_reduce_frequent_words,
            ),
            calculate_probabilities=True,
            verbose=False,
        )
        assigned, probabilities = model.fit_transform(texts, embeddings)
        assigned = np.asarray(assigned)
        probability_values = self._probabilities(
            probabilities, len(records)
        )
        topics = []
        outliers = []
        for topic_id in sorted(set(assigned.tolist())):
            indices = np.where(assigned == topic_id)[0]
            members = [
                {**records[i], "cluster_probability": probability_values[i]}
                for i in indices
            ]
            if topic_id == -1:
                outliers.extend(members)
                continue
            terms = model.get_topic(int(topic_id)) or []
            topics.append(
                {
                    "topic_id": int(topic_id),
                    "document_count": len(indices),
                    "keywords": [
                        {"term": term, "ctfidf_score": float(score)}
                        for term, score in terms[: cfg.top_terms]
                    ],
                    "mean_pairwise_cosine_similarity": self._cohesion(
                        embeddings[indices]
                    ),
                    "mean_cluster_probability": self._mean(
                        [probability_values[i] for i in indices]
                    ),
                    member_key: members,
                }
            )
        common["processing"]["duration_seconds"] = round(
            time.monotonic() - started, 3
        )
        return {
            **common,
            "mode": "bertopic",
            "topics": topics,
            "outliers": outliers,
            "effective_config": asdict(cfg),
            "adjustments": adjustments,
            "warnings": [],
        }

    @staticmethod
    def _probabilities(probabilities, count):
        if probabilities is None:
            return [None] * count
        values = np.asarray(probabilities)
        values = values.max(axis=1) if values.ndim == 2 else values
        return [float(value) for value in values]

    @staticmethod
    def _cohesion(embeddings):
        if len(embeddings) < 2:
            return None
        block = embeddings @ embeddings.T
        return float(block[np.triu_indices(len(embeddings), 1)].mean())

    @staticmethod
    def _mean(values):
        usable = [value for value in values if value is not None]
        return float(np.mean(usable)) if usable else None


def compact_evaluation(full: dict):
    topics = full.get("topics", [])
    outliers = full.get("outliers", [])
    sizes = [topic["document_count"] for topic in topics]
    clustered = sum(sizes)
    total = clustered + len(outliers)
    skipped = len(full.get("skipped_items", []))
    cohesions = [
        topic["mean_pairwise_cosine_similarity"]
        for topic in topics
        if topic.get("mean_pairwise_cosine_similarity") is not None
    ]
    probabilities = [
        topic["mean_cluster_probability"]
        for topic in topics
        if topic.get("mean_cluster_probability") is not None
    ]
    outlier_ratio = len(outliers) / total if total else 0
    largest = max(sizes, default=0)
    largest_ratio = largest / clustered if clustered else 0
    mean_cohesion = (
        float(np.mean(cohesions)) if cohesions else None
    )
    mean_probability = (
        float(np.mean(probabilities)) if probabilities else None
    )
    concerns = []
    if len(topics) <= 1 and total >= 6:
        concerns.append(
            {
                "code": "TOO_FEW_TOPICS",
                "message": "Only one regular topic was produced.",
            }
        )
    if outlier_ratio > 0.35:
        concerns.append(
            {
                "code": "HIGH_OUTLIER_RATIO",
                "message": "More than 35% of usable items are outliers.",
            }
        )
    if largest_ratio > 0.70 and len(topics) > 1:
        concerns.append(
            {
                "code": "DOMINANT_TOPIC",
                "message": "One topic contains more than 70% of clustered items.",
            }
        )
    if mean_cohesion is not None and mean_cohesion < 0.45:
        concerns.append(
            {
                "code": "LOW_COHESION",
                "message": "Average within-topic similarity is low.",
            }
        )
    score = (
        0.5
        + (
            0.30 * max(0, min(1, mean_cohesion))
            if mean_cohesion is not None
            else 0
        )
        + (
            0.20 * max(0, min(1, mean_probability))
            if mean_probability is not None
            else 0
        )
        - 0.25 * outlier_ratio
    )
    if largest_ratio > 0.7:
        score -= 0.15 * (largest_ratio - 0.7) / 0.3
    score = max(0, min(1, score))
    rating = (
        "good"
        if score >= 0.72 and not concerns
        else ("acceptable" if score >= 0.55 else "weak")
    )
    noun = "images" if full.get("input_type") == "image_descriptions" else "files"
    return {
        "status": full.get("status", "completed"),
        "input_type": full.get("input_type"),
        "mode": full["mode"],
        "dataset": {
            f"{noun}_received": clustered + len(outliers) + skipped,
            f"{noun}_clustered": clustered,
            f"{noun}_skipped": skipped,
            f"outlier_{noun}": len(outliers),
        },
        "clustering": {
            "topic_count": len(topics),
            "smallest_topic_size": min(sizes, default=0),
            "largest_topic_size": largest,
            "largest_topic_ratio": round(largest_ratio, 3),
            "outlier_ratio": round(outlier_ratio, 3),
            "mean_cluster_probability": (
                None if mean_probability is None else round(mean_probability, 3)
            ),
            "mean_topic_cohesion": (
                None if mean_cohesion is None else round(mean_cohesion, 3)
            ),
        },
        "topic_previews": [
            {
                "topic_id": topic["topic_id"],
                "item_count": topic["document_count"],
                "keywords": [item["term"] for item in topic["keywords"][:5]],
                "cohesion": topic.get("mean_pairwise_cosine_similarity"),
                "mean_probability": topic.get("mean_cluster_probability"),
            }
            for topic in topics
        ],
        "effective_config": full.get("effective_config", {}),
        "adjustments": full.get("adjustments", []),
        "evaluation": {
            "score": round(score, 3),
            "rating": rating,
            "concerns": concerns,
        },
        "warnings": full.get("warnings", []),
    }