from __future__ import annotations
import logging
from pydantic import BaseModel, Field, model_validator
from .tuning import ClusteringOverrides, Strategy

LOG = logging.getLogger(__name__)


class ImageDescription(BaseModel):
    """One image and its caller-generated semantic description."""
    image_id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=500)
    relative_path: str | None = Field(default=None, max_length=4000)
    absolute_path: str = Field(min_length=1, max_length=4000)
    description: str = Field(min_length=20, max_length=4000)


class ImageDescriptionBatch(BaseModel):
    """Validated image-description batch for BERTopic clustering."""
    images: list[ImageDescription] = Field(min_length=1, max_length=500)
    strategy: Strategy = "auto"
    overrides: ClusteringOverrides | None = None

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [item.image_id for item in self.images]
        if len(ids) != len(set(ids)):
            raise ValueError("Every image_id must be unique within the batch")
        return self


def cluster_image_descriptions(service, batch: ImageDescriptionBatch, queue_wait: float = 0.0) -> dict:
    """Embed descriptions without cache, then use the shared clustering engine."""
    texts: list[str] = []
    vectors = []
    records: list[dict] = []
    skipped: list[dict] = []

    for item in batch.images:
        record = {
            "image_id": item.image_id,
            "name": item.name,
            "relative_path": item.relative_path,
            "absolute_path": item.absolute_path,
            "description": item.description,
        }
        try:
            vector, _, _ = service.embedder.embed(item.description)
            texts.append(item.description)
            vectors.append(vector)
            records.append(record)
        except Exception as exc:
            LOG.exception("Description embedding failed for image %s", item.image_id)
            skipped.append({
                **record,
                "reason": {"code": "EMBEDDING_FAILED", "message": str(exc)},
            })

    return service.cluster_prepared_texts(
        texts=texts,
        vectors=vectors,
        records=records,
        skipped=skipped,
        input_type="image_descriptions",
        member_key="images",
        strategy=batch.strategy,
        overrides=batch.overrides,
        queue_wait=queue_wait,
        request={
            "image_count": len(batch.images),
            "strategy": batch.strategy,
            "embedding_cache_used": False,
        },
        cache_stats={"enabled": False, "hits": 0, "misses": len(vectors)},
    )
