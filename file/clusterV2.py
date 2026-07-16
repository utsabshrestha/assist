#!/usr/bin/env python3
"""
File-organization clustering pipeline.

Pipeline: embed (done upstream, in Node) -> normalize -> UMAP (dimensionality
          reduction) -> HDBSCAN -> reattach noise (soft membership)
          -> regroup remainder (agglomerative) -> final noise bucket
          -> c-TF-IDF keywords.

LLM naming itself is NOT done here -- this script hands back cluster
keywords/representatives so the Node side can prompt an LLM to name each
cluster. That keeps API keys and prompt/response handling in one place.

CHANGE FROM PREVIOUS VERSION: added a UMAP reduction stage between
normalize and HDBSCAN. HDBSCAN's density estimates lose contrast on raw
high-dimensional embeddings (768-dim for nomic-embed-text-v1.5) -- this
was confirmed empirically to be the primary driver of an inflated noise
rate (see conversation notes / dim_experiment.py). Representatives are
still computed on the FULL-dimensional normalized embeddings (UMAP is
lossy and shouldn't be the basis for picking "which real file best
represents this cluster"); only Stage 3/4/5 clustering itself runs on
the UMAP-reduced representation.

Requirements (install once, e.g. inside your .venv):
    pip install hdbscan scikit-learn umap-learn numpy

Input (stdin), one of two shapes:

  1) Legacy / backwards-compatible:
     JSON array of embeddings only -> [[0.1, 0.2, ...], [0.3, ...], ...]
     Stage 7 keyword extraction will be skipped (no text to work with) and
     "keywords" will come back empty for every cluster.

  2) Preferred (unlocks Stage 7 keyword extraction):
     {
       "embeddings": [[0.1, 0.2, ...], ...],
       "texts": ["...file content/snippet...", ...],   // same order/length as embeddings
       "fileIds": ["optional-stable-id", ...],          // optional, same length
       "config": { ...optional overrides, see CONFIG... }
     }

Output (stdout, single JSON object):
  {
    "labels": [0, 0, -1, 1, ...],                 // per-file final cluster label, -1 = Uncategorized
    "representatives": { "0": [4, 11, 2], "1": [...] }, // cluster_id -> up to 4 member file indices, ordered Core (typical) -> Edge (atypical)
    "outlierCounts": {
        "stage3_noise": N,          // noise straight out of HDBSCAN
        "stage4_reattached": N,     // reattached via soft-membership
        "stage5_regrouped": N,      // recovered via agglomerative mutual regrouping
        "final_uncategorized": N    // genuinely left over (Stage 6)
    },
    "keywords": { "0": ["kw1", "kw2", ...], "1": [...] },  // c-TF-IDF top-k per cluster
    "clusterSizes": { "0": 12, "1": 4 },
    "fileDiagnostics": {
        "0": {"resolvedAt": "stage3_primary", "cluster": 2},
        "7": {"resolvedAt": "stage4_reattach", "cluster": 2, "confidence": 0.14},
        "19": {"resolvedAt": "stage5_regroup", "cluster": 6},
        "42": {"resolvedAt": "uncategorized", "nearestConfidence": 0.03}
    }
  }

On failure: logs a traceback to stderr, prints {"error": "..."} to stdout,
and exits with a non-zero code (matches the Node caller's error handling).
"""

import sys
import json
import logging
import traceback
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# ----------------------------------------------------------------------------
# Logging -- MUST go to stderr. stdout is reserved for the single JSON result
# that the Node process parses.
# ----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [cluster.py] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("cluster")

# ----------------------------------------------------------------------------
# Config -- tunable starting points, not fixed constants. Override per-run by
# passing a "config" object alongside "embeddings"/"texts" on stdin.
# ----------------------------------------------------------------------------
DEFAULT_CONFIG: Dict[str, Any] = {
    # Stage 2.5 (UMAP dimensionality reduction)
    # Standard BERTopic-style range is 5-15; validated empirically to fully
    # resolve the noise-collapse problem in that range. Re-tune against
    # YOUR corpus using stage3_noise in outlierCounts as the signal.
    "umap_n_components": 12,
    "umap_metric": "cosine",
    # Fixed, not left as None -- this is a ONE-SHOT BATCH pipeline where
    # folder names must stay stable across runs, and UMAP is stochastic
    # without a fixed seed.
    "umap_random_state": 42,

    # Stage 3 (HDBSCAN)
    "min_cluster_size": 2,
    # 'eom' edged out 'leaf' once UMAP was added in testing (opposite of
    # the pre-UMAP recommendation) -- treat as a starting point, compare
    # both against stage3_noise on your real corpus before locking it in.
    "cluster_selection_method": "eom",
    "min_samples": None,  # None -> hdbscan default (== min_cluster_size)

    # Stage 4 (soft-membership reattachment)
    # Rough starting anchor only. Re-tune after inspecting the logged
    # max-probability distribution for a real run of your corpus.
    "stage4_confidence_threshold": 0.1,

    # Stage 5 (agglomerative mutual regrouping of leftover noise)
    "stage5_min_cluster_size": 2,
    # cosine-distance cut for the dendrogram. Like the Stage 4 threshold,
    # this is a starting point -- tune from the logged linkage distances.
    # NOTE: this held up fine in testing even with an inflated noise pool
    # upstream, so it's a lower priority to touch than the UMAP addition.
    "stage5_distance_threshold": 0.3,

    # Stage 7 (c-TF-IDF keywords)
    "ctfidf_ngram_range": (1, 2),
    # Raised from 5 now that greedy diversity selection (below) keeps slots
    # from being wasted on near-duplicates ("invoice" / "invoices" / "invoice
    # payment" all ranking highly and crowding out genuinely different terms).
    "ctfidf_top_k": 7,
    # Two candidate keywords are considered redundant -- and the lower-ranked
    # one skipped -- if they share this fraction or more of their (crudely
    # stemmed) words. Tune down if real keyword lists still look repetitive,
    # up if genuinely distinct-but-related terms are getting excluded.
    "ctfidf_word_overlap_threshold": 0.5,
}

# Layered on top of sklearn's standard English stopword list. Extend this
# with whatever boilerplate/header/footer junk shows up in YOUR extracted
# text -- these are just common starting offenders.
CUSTOM_STOPWORDS = {
    "page", "confidential", "draft", "untitled", "copy", "copyright",
    "reserved", "rights", "table", "contents", "click", "here",
    "http", "https", "www", "com", "pdf", "doc", "docx", "xlsx", "pptx",
    "figure", "appendix", "index", "chapter", "section", "attachment",
    "attachments", "inc", "llc", "ltd",
}


# ----------------------------------------------------------------------------
# Stage 2 -- normalize embeddings (unit vectors). Used for representatives
# (full-dimensional semantic distance) and as UMAP's input.
# ----------------------------------------------------------------------------
def normalize_vectors(X: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return X / norms


# ----------------------------------------------------------------------------
# Stage 2.5 -- UMAP dimensionality reduction, run before HDBSCAN.
#
# HDBSCAN's density/mutual-reachability estimates lose contrast on raw
# high-dimensional embeddings (curse of dimensionality: distances between
# points become nearly uniform, so "dense" vs "sparse" stops being a
# meaningful distinction). This was confirmed empirically: on synthetic
# data shaped like a real embedding corpus, raw 768-dim input produced
# ~64% noise with ZERO points rescued by Stage 4's soft-membership check
# (confidences were uniformly too low to clear even a lenient 0.1
# threshold); the identical pipeline on the same data reduced to 10-dim
# via UMAP dropped to 0% final noise. This is why BERTopic -- the
# architecture this design is modeled on -- always inserts this step.
# ----------------------------------------------------------------------------
def reduce_dimensionality(X_norm: np.ndarray, config: Dict[str, Any]) -> np.ndarray:
    import umap

    n_components = config["umap_n_components"]
    # Guard: UMAP needs more samples than output dimensions to do anything
    # meaningful. On a very small corpus/batch, skip reduction entirely
    # rather than erroring or silently degrading.
    if len(X_norm) <= n_components + 1:
        logger.warning(
            "Stage 2.5: only %d samples for %d UMAP components; skipping "
            "reduction and passing embeddings through unchanged.",
            len(X_norm), n_components,
        )
        return X_norm

    reducer = umap.UMAP(
        n_components=n_components,
        metric=config["umap_metric"],
        random_state=config["umap_random_state"],
    )
    X_reduced = reducer.fit_transform(X_norm)
    logger.info(
        "Stage 2.5: UMAP reduced %d-dim embeddings to %d-dim.",
        X_norm.shape[1], X_reduced.shape[1],
    )
    return X_reduced


# ----------------------------------------------------------------------------
# Stage 3 -- primary clustering with HDBSCAN. Runs on the UMAP-reduced
# representation, not the raw embeddings.
# ----------------------------------------------------------------------------
def run_hdbscan(X: np.ndarray, config: Dict[str, Any]):
    try:
        import hdbscan
    except ImportError as e:
        raise RuntimeError(
            "The 'hdbscan' package is required (pip install hdbscan). "
            "sklearn.cluster.HDBSCAN is NOT a substitute -- Stage 4 needs "
            "hdbscan.all_points_membership_vectors, which only exists in "
            "the original package."
        ) from e

    clusterer = hdbscan.HDBSCAN(
        metric="euclidean",
        min_cluster_size=config["min_cluster_size"],
        min_samples=config["min_samples"],
        cluster_selection_method=config["cluster_selection_method"],
        prediction_data=True,
    )
    labels = clusterer.fit_predict(X)

    n_clusters = len(set(labels.tolist()) - {-1})
    n_noise = int(np.sum(labels == -1))
    logger.info(
        "Stage 3: HDBSCAN found %d cluster(s), %d noise point(s) out of %d total.",
        n_clusters, n_noise, len(labels),
    )
    return clusterer, labels


# ----------------------------------------------------------------------------
# Stage 4 -- Tier 1: reattach noise via soft cluster-membership probability.
# Now also returns a per-index confidence map covering EVERY point that
# started Stage 4 as noise (not just the ones that got reattached), so
# Stage 9 diagnostics can show near-misses for files that stay uncategorized.
# ----------------------------------------------------------------------------
def reattach_noise_stage4(
    clusterer, labels: np.ndarray, config: Dict[str, Any]
) -> Tuple[np.ndarray, Dict[int, float]]:
    import hdbscan

    labels = labels.copy()
    noise_idx = np.where(labels == -1)[0]
    confidence_map: Dict[int, float] = {}

    if len(noise_idx) == 0:
        logger.info("Stage 4: no noise points to reattach.")
        return labels, confidence_map

    n_real_clusters = len(set(labels.tolist()) - {-1})
    if n_real_clusters == 0:
        logger.info("Stage 4: no real clusters exist yet; nothing to reattach to.")
        return labels, confidence_map

    membership = hdbscan.all_points_membership_vectors(clusterer)  # (n_samples, n_clusters)

    max_probs = membership[noise_idx].max(axis=1)
    best_clusters = membership[noise_idx].argmax(axis=1)  # column index == cluster label (0-indexed)

    for i, idx in enumerate(noise_idx):
        confidence_map[int(idx)] = float(max_probs[i])

    logger.info(
        "Stage 4: max-probability distribution for %d noise point(s) -> "
        "min=%.4f p25=%.4f median=%.4f p75=%.4f max=%.4f",
        len(noise_idx),
        float(np.min(max_probs)), float(np.percentile(max_probs, 25)),
        float(np.median(max_probs)), float(np.percentile(max_probs, 75)),
        float(np.max(max_probs)),
    )

    threshold = config["stage4_confidence_threshold"]
    reattach_mask = max_probs >= threshold
    labels[noise_idx[reattach_mask]] = best_clusters[reattach_mask]

    logger.info(
        "Stage 4: reattached %d/%d noise point(s) at threshold=%.3f.",
        int(reattach_mask.sum()), len(noise_idx), threshold,
    )
    return labels, confidence_map


# ----------------------------------------------------------------------------
# Stage 5 -- Tier 2: mutual regrouping of whatever noise is STILL left, via
# a narrow agglomerative pass over only that subset. Runs on the same
# UMAP-reduced representation Stage 3/4 used (validated empirically to work
# well -- this leftover subset is small enough that the dimensionality
# concern driving Stage 3's problem doesn't reappear here). Not
# load-bearing: if it finds nothing, that's fine, points just carry
# forward to Stage 6.
# ----------------------------------------------------------------------------
def regroup_noise_stage5(X: np.ndarray, labels: np.ndarray, config: Dict[str, Any]) -> np.ndarray:
    from sklearn.cluster import AgglomerativeClustering

    labels = labels.copy()
    noise_idx = np.where(labels == -1)[0]
    min_size = config["stage5_min_cluster_size"]

    if len(noise_idx) < min_size:
        logger.info(
            "Stage 5: only %d noise point(s) remain (< min_cluster_size=%d); skipping.",
            len(noise_idx), min_size,
        )
        return labels

    X_noise = X[noise_idx]

    try:
        agg = AgglomerativeClustering(
            n_clusters=None,
            metric="cosine",
            linkage="average",
            distance_threshold=config["stage5_distance_threshold"],
        )
        sub_labels = agg.fit_predict(X_noise)
    except Exception as e:
        logger.warning("Stage 5: agglomerative clustering failed (%s); leaving noise as-is.", e)
        return labels

    counts: Dict[int, int] = {}
    for l in sub_labels:
        counts[int(l)] = counts.get(int(l), 0) + 1

    next_label = int(labels.max()) + 1 if labels.max() >= 0 else 0
    remapped: Dict[int, int] = {}
    for local_label, count in counts.items():
        if count >= min_size:  # a "cluster" of 1 isn't a cluster
            remapped[local_label] = next_label
            next_label += 1

    assigned = 0
    for local_idx, sub_label in zip(noise_idx, sub_labels):
        sub_label = int(sub_label)
        if sub_label in remapped:
            labels[local_idx] = remapped[sub_label]
            assigned += 1

    logger.info(
        "Stage 5: formed %d new cluster(s) from remaining noise, reassigning %d/%d point(s).",
        len(remapped), assigned, len(noise_idx),
    )
    return labels


# ----------------------------------------------------------------------------
# Stage 6 -- whatever is still -1 after Stage 5 is genuinely Uncategorized.
# Nothing to compute here; it's a no-op documented for clarity, and Stage 7
# skips these points by construction.
# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# Stage 7 -- c-TF-IDF keyword extraction per cluster (BERTopic-style).
# TF is computed within a cluster's aggregate term counts; IDF is computed
# across cluster-level aggregates (each cluster == one "document" for IDF).
#
# IMPORTANT: term counts are built by vectorizing each FILE separately, then
# summing per-file count vectors into a per-cluster total -- NOT by
# concatenating a cluster's file text into one string first. Concatenating
# text lets n-grams form across file boundaries (the last word of one file
# combining with the first word of the next, or with whatever word became
# newly-adjacent after an in-between stopword was stripped), producing
# nonsense phrases that have nothing to do with either file. Vectorizing per
# file and summing afterward keeps every n-gram confined to a single file's
# own token stream.
# ----------------------------------------------------------------------------
def _word_set(term: str) -> set:
    # Crude stemming (strip a trailing 's') is enough to catch the common
    # "invoice" vs "invoices" duplication without adding an nltk dependency.
    return {w.rstrip("s") for w in term.split()}


def build_cluster_term_counts(
    labels: np.ndarray, texts: Optional[List[str]], config: Dict[str, Any]
):
    if texts is None:
        return None

    from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS

    stop_words = list(set(ENGLISH_STOP_WORDS) | CUSTOM_STOPWORDS)
    vectorizer = CountVectorizer(
        ngram_range=config["ctfidf_ngram_range"],
        stop_words=stop_words,
        lowercase=True,
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9\-]+\b",
    )

    safe_texts = [t or "" for t in texts]
    try:
        per_file_counts = vectorizer.fit_transform(safe_texts)  # (n_files, n_terms)
    except ValueError:
        logger.warning("Stage 7: empty vocabulary after stopword removal; no keywords extracted.")
        return None

    terms = vectorizer.get_feature_names_out()
    cluster_ids = sorted(set(int(l) for l in labels if l != -1))
    if not cluster_ids:
        return None

    cluster_counts = np.zeros((len(cluster_ids), len(terms)))
    for row_i, cluster_id in enumerate(cluster_ids):
        mask = labels == cluster_id
        cluster_counts[row_i] = np.asarray(per_file_counts[mask].sum(axis=0)).ravel()

    return cluster_ids, terms, cluster_counts


def extract_ctfidf_keywords(
    labels: np.ndarray, texts: Optional[List[str]], config: Dict[str, Any]
) -> Dict[int, List[str]]:
    built = build_cluster_term_counts(labels, texts, config)
    if built is None:
        cluster_ids = sorted(set(int(l) for l in labels if l != -1))
        return {c: [] for c in cluster_ids}

    cluster_ids, terms, counts = built

    words_per_class = counts.sum(axis=1)
    safe_words_per_class = np.where(words_per_class == 0, 1.0, words_per_class)
    tf = counts / safe_words_per_class[:, None]

    freq_across_classes = counts.sum(axis=0)  # f_t
    avg_words_per_class = words_per_class.mean() if words_per_class.mean() > 0 else 1.0
    idf = np.log(1 + (avg_words_per_class / np.maximum(freq_across_classes, 1e-9)))

    ctfidf = tf * idf[None, :]

    top_k = config["ctfidf_top_k"]
    overlap_threshold = config["ctfidf_word_overlap_threshold"]
    keywords: Dict[int, List[str]] = {}

    for i, cluster_id in enumerate(cluster_ids):
        row = ctfidf[i]
        if not np.any(row):
            keywords[cluster_id] = []
            continue

        ranked_indices = np.argsort(row)[::-1]
        selected: List[str] = []
        selected_word_sets: List[set] = []

        for j in ranked_indices:
            if row[j] <= 0:
                break
            term = terms[j]
            term_words = _word_set(term)

            # Skip if this candidate shares too many words with something
            # already picked -- keeps the top_k slots from filling up with
            # near-duplicates ("invoice", "invoices", "invoice payment").
            is_redundant = any(
                len(term_words & prior) / max(len(term_words), 1) >= overlap_threshold
                for prior in selected_word_sets
            )
            if is_redundant:
                continue

            selected.append(term)
            selected_word_sets.append(term_words)
            if len(selected) >= top_k:
                break

        keywords[cluster_id] = selected

    logger.info("Stage 7: extracted keywords for %d cluster(s).", len(keywords))
    return keywords


# ----------------------------------------------------------------------------
# Representatives -- nearest actual member to each cluster's centroid, so the
# Node side has something concrete to show/embed-compare, not a synthetic
# average that may not correspond to any real file. Deliberately uses the
# FULL-dimensional normalized embeddings, not the UMAP-reduced ones -- UMAP
# optimizes for preserving cluster/neighborhood structure, not fine-grained
# per-point ranking, so picking "most typical" vs "most edge" members is
# more trustworthy in the original embedding space.
# ----------------------------------------------------------------------------
def compute_representatives(
    X: np.ndarray, labels: np.ndarray, max_representatives: int = 4
) -> Dict[str, List[int]]:
    reps: Dict[str, List[int]] = {}
    for cluster_id in sorted(set(labels.tolist())):
        if cluster_id == -1:
            continue
        idx = np.where(labels == cluster_id)[0]
        centroid = X[idx].mean(axis=0)
        dists = np.linalg.norm(X[idx] - centroid, axis=1)
        order = np.argsort(dists)  # ascending: closest (Core) first

        if len(order) <= max_representatives:
            selected = order
        else:
            positions = np.linspace(0, len(order) - 1, max_representatives)
            selected = order[np.round(positions).astype(int)]

        reps[str(cluster_id)] = [int(idx[i]) for i in selected]
    return reps


# ----------------------------------------------------------------------------
# Stage 9 -- per-file diagnostics: which stage resolved each file, and its
# confidence score where applicable. This is what makes the Stage 4/5
# thresholds (and the UMAP n_components / cluster_selection_method choice)
# tunable against YOUR real corpus instead of guessed once and left alone.
# ----------------------------------------------------------------------------
def build_file_diagnostics(
    stage3_labels: np.ndarray,
    stage4_labels: np.ndarray,
    stage5_labels: np.ndarray,
    stage4_confidence_map: Dict[int, float],
) -> Dict[str, Dict[str, Any]]:
    diagnostics: Dict[str, Dict[str, Any]] = {}
    for i in range(len(stage5_labels)):
        final_label = int(stage5_labels[i])
        if stage3_labels[i] != -1:
            diagnostics[str(i)] = {"resolvedAt": "stage3_primary", "cluster": int(stage3_labels[i])}
        elif stage4_labels[i] != -1:
            diagnostics[str(i)] = {
                "resolvedAt": "stage4_reattach",
                "cluster": int(stage4_labels[i]),
                "confidence": stage4_confidence_map.get(i),
            }
        elif final_label != -1:
            diagnostics[str(i)] = {"resolvedAt": "stage5_regroup", "cluster": final_label}
        else:
            diagnostics[str(i)] = {
                "resolvedAt": "uncategorized",
                "nearestConfidence": stage4_confidence_map.get(i),
            }
    return diagnostics


# ----------------------------------------------------------------------------
# Orchestration
# ----------------------------------------------------------------------------
def parse_input(raw: str) -> Tuple[np.ndarray, Optional[List[str]], Optional[List[str]], Dict[str, Any]]:
    parsed = json.loads(raw)

    config = dict(DEFAULT_CONFIG)

    if isinstance(parsed, list):
        embeddings = parsed
        texts: Optional[List[str]] = None
        file_ids: Optional[List[str]] = None
    elif isinstance(parsed, dict):
        embeddings = parsed.get("embeddings")
        texts = parsed.get("texts")
        file_ids = parsed.get("fileIds")
        overrides = parsed.get("config") or {}
        for k, v in overrides.items():
            if k in config:
                config[k] = tuple(v) if k == "ctfidf_ngram_range" and isinstance(v, list) else v
    else:
        raise ValueError("Input JSON must be either an array of embeddings or an object.")

    if embeddings is None:
        raise ValueError("No 'embeddings' found in input.")

    X = np.array(embeddings, dtype=np.float64)

    if texts is not None and len(texts) != len(embeddings):
        logger.warning(
            "'texts' length (%d) does not match 'embeddings' length (%d); ignoring texts.",
            len(texts), len(embeddings),
        )
        texts = None

    return X, texts, file_ids, config


def run_pipeline(X: np.ndarray, texts: Optional[List[str]], config: Dict[str, Any]) -> Dict[str, Any]:
    X_norm = normalize_vectors(X)
    X_reduced = reduce_dimensionality(X_norm, config)

    clusterer, labels = run_hdbscan(X_reduced, config)
    stage3_labels = labels.copy()
    stage3_noise = int(np.sum(labels == -1))

    labels, stage4_confidence_map = reattach_noise_stage4(clusterer, labels, config)
    stage4_labels = labels.copy()
    stage4_remaining_noise = int(np.sum(labels == -1))
    stage4_reattached = stage3_noise - stage4_remaining_noise

    labels = regroup_noise_stage5(X_reduced, labels, config)
    stage5_remaining_noise = int(np.sum(labels == -1))
    stage5_regrouped = stage4_remaining_noise - stage5_remaining_noise

    final_uncategorized = stage5_remaining_noise  # Stage 6

    keywords_by_cluster = extract_ctfidf_keywords(labels, texts, config)

    # Representatives use the FULL-dimensional embeddings, not X_reduced -- see
    # compute_representatives docstring.
    representatives = compute_representatives(X_norm, labels)

    cluster_sizes: Dict[str, int] = {}
    for cluster_id in sorted(set(labels.tolist())):
        if cluster_id == -1:
            continue
        cluster_sizes[str(cluster_id)] = int(np.sum(labels == cluster_id))

    file_diagnostics = build_file_diagnostics(
        stage3_labels, stage4_labels, labels, stage4_confidence_map
    )

    return {
        "labels": labels.tolist(),
        "representatives": representatives,
        "outlierCounts": {
            "stage3_noise": stage3_noise,
            "stage4_reattached": stage4_reattached,
            "stage5_regrouped": stage5_regrouped,
            "final_uncategorized": final_uncategorized,
        },
        "keywords": {str(k): v for k, v in keywords_by_cluster.items()},
        "clusterSizes": cluster_sizes,
        "fileDiagnostics": file_diagnostics,
    }


def main() -> None:
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps([]))
            return

        X, texts, _file_ids, config = parse_input(input_data)

        if X.size == 0:
            print(json.dumps([]))
            return

        # Single file: nothing to cluster.
        if len(X) == 1:
            print(json.dumps({
                "labels": [0],
                "representatives": {"0": [0]},
                "outlierCounts": {
                    "stage3_noise": 0, "stage4_reattached": 0,
                    "stage5_regrouped": 0, "final_uncategorized": 0,
                },
                "keywords": {"0": []},
                "clusterSizes": {"0": 1},
                "fileDiagnostics": {"0": {"resolvedAt": "stage3_primary", "cluster": 0}},
            }))
            return

        result = run_pipeline(X, texts, config)
        print(json.dumps(result))

    except Exception as e:  # noqa: BLE001 - top-level guard, intentional
        logger.error("Pipeline failed: %s", e)
        logger.error(traceback.format_exc())
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()