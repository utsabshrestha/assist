from __future__ import annotations
from dataclasses import asdict, dataclass
from typing import Literal
from pydantic import BaseModel, Field, model_validator

Strategy = Literal["auto", "balanced", "small_collection", "more_specific_topics", "fewer_broader_topics", "strict_high_confidence"]

class ClusteringOverrides(BaseModel):
    """Optional bounded overrides. Prefer a strategy; override only to address a specific diagnostic."""
    min_topic_size: int | None = Field(None, ge=2, le=50)
    top_terms: int | None = Field(None, ge=3, le=20)
    umap_n_neighbors: int | Literal["auto"] | None = None
    hdbscan_min_cluster_size: int | Literal["auto"] | None = None
    hdbscan_cluster_selection_method: Literal["eom", "leaf"] | None = None

    @model_validator(mode="after")
    def validate_numbers(self):
        for name in ("umap_n_neighbors", "hdbscan_min_cluster_size"):
            value = getattr(self, name)
            if isinstance(value, int) and not 2 <= value <= 50:
                raise ValueError(f"{name} must be 'auto' or an integer from 2 through 50")
        return self

@dataclass(frozen=True)
class EffectiveConfig:
    strategy: str
    min_topic_size: int
    top_terms: int
    umap_n_neighbors: int
    umap_n_components: int
    hdbscan_min_cluster_size: int
    hdbscan_cluster_selection_method: str

PROFILES = {
    "balanced": {"min_topic_size": 3, "neighbors": 8, "min_cluster": 3, "method": "eom"},
    "small_collection": {"min_topic_size": 2, "neighbors": 3, "min_cluster": 2, "method": "leaf"},
    "more_specific_topics": {"min_topic_size": 2, "neighbors": 4, "min_cluster": 2, "method": "leaf"},
    "fewer_broader_topics": {"min_topic_size": 4, "neighbors": 12, "min_cluster": 4, "method": "eom"},
    "strict_high_confidence": {"min_topic_size": 4, "neighbors": 8, "min_cluster": 4, "method": "eom"},
}

def resolve_config(strategy: Strategy, overrides: ClusteringOverrides | None, document_count: int, settings):
    requested = strategy
    selected = "small_collection" if strategy == "auto" and document_count <= 10 else ("balanced" if strategy == "auto" else strategy)
    profile = PROFILES[selected]
    ov = overrides or ClusteringOverrides()
    adjustments=[]
    requested_neighbors = ov.umap_n_neighbors if ov.umap_n_neighbors is not None else profile["neighbors"]
    neighbors = max(2, min(15 if requested_neighbors == "auto" else requested_neighbors, document_count - 1))
    if requested_neighbors != "auto" and neighbors != requested_neighbors:
        adjustments.append({"parameter":"umap_n_neighbors","requested":requested_neighbors,"effective":neighbors,"reason":"Must be smaller than the usable document count."})
    requested_cluster = ov.hdbscan_min_cluster_size if ov.hdbscan_min_cluster_size is not None else profile["min_cluster"]
    cluster = max(2, min(max(2, document_count // 2), settings.min_topic_size if requested_cluster == "auto" else requested_cluster))
    if requested_cluster != "auto" and cluster != requested_cluster:
        adjustments.append({"parameter":"hdbscan_min_cluster_size","requested":requested_cluster,"effective":cluster,"reason":"Clamped for the current collection size."})
    cfg=EffectiveConfig(selected, ov.min_topic_size or profile["min_topic_size"], ov.top_terms or settings.top_terms, neighbors, min(5, document_count-2), cluster, ov.hdbscan_cluster_selection_method or profile["method"])
    if requested == "auto": adjustments.append({"parameter":"strategy","requested":"auto","effective":selected,"reason":"Selected from usable document count."})
    return cfg, adjustments
