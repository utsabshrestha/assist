#!/usr/bin/env python3
"""
clusterV3.py -- BERTopic-based file-organization clustering.

DROP-IN replacement for clusterV2.py. Same stdin/stdout JSON contract, so
classificationUtility.ts and fileClassificationTool.ts need NO changes
(one deliberate, backward-safe semantic change to `outlierCounts` -- see below).

------------------------------------------------------------------------------
What changed vs v2
------------------------------------------------------------------------------
v2 was effectively a hand-rolled BERTopic:
    normalize -> UMAP -> HDBSCAN -> soft-membership reattach
              -> agglomerative regroup -> c-TF-IDF keywords
v3 delegates the same shape of pipeline to the real BERTopic library:
    embeddings(from Node) -> UMAP -> HDBSCAN -> c-TF-IDF
              -> reduce_outliers (reassign noise to nearest real topic)
              -> merge_near_duplicate_clusters (fuse literal duplicate files)

Representatives and per-cluster outlier counts are STILL computed here, on the
full-dimensional embeddings, because BERTopic doesn't expose them in the
index-based, Core->Edge form the Node side consumes.

Keyword diversity (v2's greedy "invoice/invoices/invoice payment" dedup) is
kept and applied on top of BERTopic's raw c-TF-IDF words. We deliberately do
NOT use BERTopic's MaximalMarginalRelevance representation, because MMR needs
to embed candidate WORDS, which would force loading an embedding model into
Python -- the whole point of your setup is that embeddings come from Node
(nomic via node-llama-cpp) and Python stays model-free / fast to start.

------------------------------------------------------------------------------
v3.1 -- first real-data pass
------------------------------------------------------------------------------
A run on ~190 files showed a diagnosable failure pattern: near-duplicate
documents (multiple resume versions, multiple copies of "Chapter 6", multiple
VedicReport exports) were landing in TWO DIFFERENT clusters, or split between
a real cluster and Uncategorized ("-1"). v3.1 turned on `reduce_outliers`
(existing knob, was OFF) and added `reduce_topics(docs, nr_topics="auto")` to
merge near-duplicate topics via c-TF-IDF cosine similarity.

------------------------------------------------------------------------------
v3.2 -- WHY THIS REVISION EXISTS (nr_topics="auto" backfired)
------------------------------------------------------------------------------
A second real run showed `nr_topics="auto"` doing the wrong thing in BOTH
directions at once:
  * It fused two large, genuinely UNRELATED topics (administrative/financial
    documents and personal-misc/astrology reports) into one 65-file cluster,
    because their aggregate c-TF-IDF (bag-of-words) vectors happened to be
    >=0.9 cosine-similar -- a known failure mode of BERTopic's automatic
    topic reduction on smaller, thinner-vocabulary corpora. Auto-merging by
    topic-level vocabulary similarity is NOT the same thing as "these are
    the same document," and apparently unrelated document types can share
    enough boilerplate/generic vocabulary to look similar in aggregate.
  * It STILL failed to merge the actual duplicates it was meant to catch --
    resumes stayed split across two clusters, "Chapter 6" copies stayed
    split across two clusters.

Conclusion: topic-level (aggregate, bag-of-words) similarity is the wrong
granularity for "these are literally the same document filed twice." That's
a per-document question. So:

  * `reduce_topics` / `nr_topics="auto"` is now OFF by default (config still
    supports it, clearly flagged, for experimentation).
  * NEW: `merge_near_duplicate_clusters` operates on raw per-document
    embedding cosine similarity instead. If any pair of files in two
    different clusters is similar enough (default threshold 0.92) to be
    confidently "the same document, different copy/version," their two
    clusters are fused via union-find. This only acts on direct file-to-file
    evidence, so it can't accidentally weld unrelated topics together the
    way aggregate keyword similarity did.
  * Every cross-cluster candidate pair down to a lower "report" threshold
    (0.80) is logged to stderr -- even non-merged ones -- so you can inspect
    real similarity values from YOUR embeddings and calibrate the merge
    threshold. There's no universal correct number for this; it depends on
    the embedding model.

`reduce_outliers` stays ON by default -- in the v3.1 test it correctly folded
genuinely-administrative noise (audit files, degree-works dashboard, a
syllabus) into the administrative cluster and genuinely-coursework noise
(a classmate's assignments) into the coursework cluster. That mechanism
wasn't the problem; `reduce_topics` was.

------------------------------------------------------------------------------
v3.3 -- the mega-cluster came back; wrong culprit identified in v3.2
------------------------------------------------------------------------------
A third real run, with `reduce_topics` now OFF, still reproduced essentially
the same ~63-file mega-cluster (administrative/financial docs fused with all
8 VedicReport astrology exports and several personal-misc books) that v3.2
blamed on `nr_topics="auto"`. Since that setting was off, it clearly wasn't
the only cause. Re-examining: v3.1's `min_samples` bump (3 -> 5) raised
HDBSCAN's density bar enough that the small, legitimate "VedicReports +
personal misc" cluster (~15 files, which formed cleanly in the very first,
pre-tuning run) no longer qualified as its own cluster and got pushed into
noise instead. `reduce_outliers`'s "embeddings" strategy has NO distance
threshold -- it always force-assigns every noise point to its single
nearest topic, however poor a fit that is -- so those files got force-fit
into the nearest big cluster (administrative documents), rebuilding the same
blob through a different mechanism. Meanwhile Aavash's assignments, also
pushed into noise, got force-fit into the math/coursework cluster correctly,
confirming reduce_outliers itself isn't broken -- it just has no way to say
"none of these are actually a good match."

Two changes:
  * `min_samples` reverted 5 -> 3 (see DEFAULT_CONFIG comment). No evidence
    supported keeping it at 5, and it looks like the actual root cause here.
  * NEW: `validate_outlier_reassignments` distance guard. After
    reduce_outliers proposes a reassignment, this checks whether the point
    actually lands within a believable distance of its new cluster's
    centroid (using that cluster's ORIGINAL member spread, not including any
    other just-reassigned points). Reassignments that don't clear the bar
    revert to -1 (Uncategorized) instead of quietly polluting an unrelated
    cluster. ON by default (`outlier_reassign_max_zscore: 2.0`).

Cluster 2's conflation of self-help/psychology books with short AI-course
slide-deck PDFs (e.g. "2- Transformers.pdf") is UNCHANGED by any of this --
it happens at the base HDBSCAN/UMAP step, before any merge stage runs. That
means the raw embeddings themselves are placing those documents close
together. Since you said you're already using a ~4k token embedding budget,
truncation isn't the likely cause; more likely those slide-deck PDFs simply
don't have much extractable body text to begin with (title/bullet-only
slides), so even a generous token budget can't manufacture distinguishing
signal that isn't in the source text. Worth checking actual extracted
character/token counts for those specific files -- if they're in the
low hundreds of tokens, no clustering-parameter change will fix that; it
needs richer input text (slide notes, OCR of diagram content, etc.).

------------------------------------------------------------------------------
v3.4 -- surfacing calibration data through stdout, not stderr
------------------------------------------------------------------------------
v3.3's fixes worked: on the next real run, VedicReports correctly formed
their own cluster again (separate from administrative docs), and the
distance guard visibly caught weak-fit reassignments and left them in "-1"
instead of polluting an unrelated cluster. Resumes are still split across
two clusters, and calibrating `duplicate_merge_similarity` needs real
similarity numbers to do properly -- but this pipeline runs as a Node child
process, and stderr (where those numbers were being logged) wasn't reaching
the console.

Rather than depend on the caller wiring up stderr, the candidate pairs are
now ALSO returned directly in the JSON result (which was already being read
successfully), as a new top-level "duplicateCandidates" key: every
cross-cluster file pair down to `duplicate_report_similarity`, sorted by
similarity, matched to the `fileIds` you passed in (or raw index if you
didn't), each flagged with whether it ended up merged. Inspect that list for
your resume/"Chapter 6" filenames to see their actual similarity scores and
decide whether to lower `duplicate_merge_similarity` -- or whether those
files genuinely aren't similar enough in embedding space to be called
"the same document" (e.g. resume versions months apart may legitimately
differ enough in content that they're not near-duplicates, just same-genre).

------------------------------------------------------------------------------
v3.5 -- the blob came back a THIRD time, with nothing else changed
------------------------------------------------------------------------------
Same input, same script, same config as the run that correctly separated
VedicReports from administrative documents -- and the very next run rebuilt
the mega-cluster again. Nothing in v3.1-v3.4's logic explains that; those
stages are all deterministic given their inputs. The remaining variable is
UMAP itself: umap-learn's documentation says setting `random_state` disables
non-reproducible parallelism, but this is unreliable in practice (see
https://github.com/lmcinnes/umap/issues/1080 and /1108 -- same input,
random_state fixed, still different output across runs). If the VedicReport
group lands in a slightly different region of the UMAP-reduced space run to
run, HDBSCAN can either find it as its own small cluster OR fold it directly
into the administrative cluster as a regular (non-noise) member -- and in
the latter case, `validate_outlier_reassignments` never even runs, because
that guard only double-checks OUTLIER reassignments, not HDBSCAN's original
cluster membership.

Fix: pin every threading layer (BLAS via env vars, UMAP's own n_jobs,
HDBSCAN's core_dist_n_jobs) to 1 BEFORE numpy/numba-backed libraries are
imported, at the very top of this file. This is the only way to get
bit-identical clustering across runs on the same input, which the file's
own `umap_random_state` comment already said was a requirement. Negligible
performance cost at this corpus size (tens to low thousands of files).

If you still see different clusterings on IDENTICAL input after this
change, the input itself is changing between runs (e.g. embeddings
regenerated with slight nondeterminism from the embedding server) rather
than anything in this script -- worth diffing two "embeddings" arrays from
consecutive runs on the same files to confirm they're byte-identical.

------------------------------------------------------------------------------
v3.6 -- input order was never controlled for; that's the real culprit
------------------------------------------------------------------------------
Diffing the raw `embeddings` array between two identical-file-set runs (per
v3.5's own suggestion) showed individual vectors unchanged in VALUE but
reordered -- and possibly offset by extra entries -- between runs. That
means every fix through v3.5 was solving a problem that could never fully
resolve on its own, because none of them controlled for input order:

  * UMAP's neighbor-graph construction and spectral-initialization
    eigensolver are not guaranteed order-invariant, especially with
    near-duplicate vectors (multiple resume versions, repeated VedicReport
    exports) -- tie-breaking during nearest-neighbor search and eigenvector
    computation can depend on which index came first. See v3.5's cited
    issues, plus https://github.com/rapidsai/cuml/issues/6696 ("UMAP
    produces unstable representations with spectral initialization and
    fixed random state") -- near-degenerate structure, which near-duplicate
    files create by definition, is exactly the regime where this bites.
  * `merge_near_duplicate_clusters` (v3.2) unions whole clusters on a
    SINGLE cross-cluster pair >= threshold. If input-order instability
    causes even one stray file to land in the wrong base cluster, and that
    stray file is a near-duplicate of files still correctly clustered
    elsewhere, this stage will weld the two ENTIRE clusters together --
    turning one misplaced file into a 60-file mega-cluster. Classic
    single-linkage chaining, and almost certainly what's been re-forming
    the administrative+VedicReport blob run after run.

Two independent fixes, since either alone leaves a gap:

  1. NEW: canonicalize input order before UMAP/HDBSCAN runs at all
     (`compute_canonical_order`), using `fileIds` (preferred -- make sure
     Node assigns these from something stable, e.g. an absolute path or a
     content hash, NOT a scan-order counter) or a hash of the
     embedding/text as a fallback when `fileIds` isn't supplied. The
     caller's original order is restored before returning
     (`restore_original_order`), so the stdin/stdout contract, and every
     index Node already reads, is unchanged. This removes input order as a
     variable, rather than hoping UMAP/HDBSCAN happen to be insensitive to
     it -- which, per the above, they aren't.
  2. NEW: `merge_near_duplicate_clusters` now refuses to union two clusters
     if BOTH already exceed `min_cluster_size *
     duplicate_merge_min_side_cap_multiple` members -- i.e. both already
     look like independently-substantial topics, not "one real topic split
     by a literal duplicate file." Small duplicate-fragment clusters can
     still merge into a big legitimate one (the intended use case); two big
     topics can no longer be silently welded by one coincidental
     high-similarity pair. Rejected candidates still show up in
     `duplicateCandidates` with a `note` explaining why, instead of quietly
     disappearing.

Also new: `umap_init` defaults to `"pca"` instead of BERTopic's default
`"spectral"`. PCA init is a fully deterministic, natively-supported UMAP
option (no eigensolver instability), which matches this pipeline's stated
requirement -- folder names need to stay stable run to run -- better than
spectral init's marginally richer global structure. Switch back to
`"spectral"` via config once canonical ordering is confirmed to have fixed
things, if you want to A/B the quality difference.

Also new: strict `fileIds` length validation (raises instead of silently
falling back to raw index on a length mismatch -- a silent mismatch here
would misattribute files to the wrong cluster with no visible error), a
warning if `fileIds` contains duplicates, and an `inputFingerprint` in
`fileDiagnostics._pipeline` (hash of the canonicalized fileIds/embeddings)
so you can confirm from the JSON output alone -- no external diffing --
whether two runs actually received the identical file set.

------------------------------------------------------------------------------
IMPORTANT -- the "3-4k token" / context-size question
------------------------------------------------------------------------------
BERTopic does NOT re-embed your documents here. It clusters the vectors YOU
pass in. So token/context limits do NOT apply to BERTopic:
  * Clustering (UMAP+HDBSCAN) uses only the embedding VECTOR -> no token limit.
  * c-TF-IDF uses raw text, but it's bag-of-words (CountVectorizer) -> no
    transformer context window; longer text is fine, even helpful for keywords.
The only real context limit is UPSTREAM, when Node embeds each file. Nothing
about chunking or truncation is imposed by anything in this script.

------------------------------------------------------------------------------
Input (stdin) -- unchanged from v2. fileIds STRONGLY recommended as of v3.6
------------------------------------------------------------------------------
  Preferred:
    {"embeddings": [[...],...], "texts": ["...",...], "fileIds": ["...",...], "config": {...}?}
  Legacy (still accepted; keywords come back empty, and order-canonicalization
  falls back to a content hash instead of fileIds -- less robust):
    [[...],[...],...]

------------------------------------------------------------------------------
Output (stdout) -- same keys as v2/v3, positions ALWAYS match the ORIGINAL
input order you sent, even though clustering runs on a canonicalized order
internally (v3.6).
------------------------------------------------------------------------------
  {
    "labels": [0, 0, -1, 1, ...],                  // -1 = Uncategorized (same as v2)
    "representatives": {"0": [4, 11, 2], ...},     // up to N member indices, Core->Edge
    "outlierCounts": {"0": 2, "1": 0, ...},        // per CLUSTER LABEL = how many members
                                                   //   sit far from the cluster centroid.
    "keywords": {"0": ["kw1","kw2",...], ...},     // c-TF-IDF top-k, diversity-deduped
    "clusterSizes": {"0": 12, "1": 4},
    "fileDiagnostics": {
        "7": {"resolvedAt":"bertopic_primary","cluster":2,"distanceToCentroid":0.31},
        "9": {"resolvedAt":"outlier_reduced","cluster":2,"distanceToCentroid":0.62},
        "42": {"resolvedAt":"uncategorized"},
        "_pipeline": {"bertopic_noise":8,"topics_merged":0,"duplicate_clusters_merged":2,
                       "reduced":6,"outlier_reassign_reverted":2,
                       "final_uncategorized":2,"nTopics":5,
                       "duplicate_merges_rejected_size_cap":1,
                       "inputFingerprint":"a1b2c3d4e5f6a7b8"}
    },
    "duplicateCandidates": [
        {"fileA":"resume_jan13.pdf","fileB":"resume_feb2.pdf","similarity":0.87,"merged":false},
        {"fileA":"chapter6_copy.pdf","fileB":"chapter6.pdf","similarity":0.98,"merged":true},
        {"fileA":"admin_form.pdf","fileB":"vedic_report.pdf","similarity":0.93,"merged":false,
         "note":"above merge threshold but rejected by size-cap guard (see v3.6)"}
    ]
  }

On failure: traceback to stderr, {"error": "..."} to stdout, non-zero exit.

Install (once, in your .venv):
    pip install bertopic
  (pulls umap-learn, hdbscan, scikit-learn, numpy, etc. as dependencies)
"""

import sys
import os

# ----------------------------------------------------------------------------
# Determinism guard -- MUST run before numpy/numba-backed libraries are
# imported (numpy's BLAS backend and numba's own thread pool both pick up
# thread counts at import/first-use time).
#
# umap-learn's docs say setting `random_state` should disable the
# non-reproducible parallel code paths, but this is unreliable in practice --
# see https://github.com/lmcinnes/umap/issues/1080 and /1108, where users
# report the SAME input still producing different UMAP embeddings across runs
# despite a fixed random_state. The underlying BLAS calls (numpy/scipy linear
# algebra used in UMAP's spectral initialization) and numba's own thread pool
# (used by both UMAP and HDBSCAN) are outside UMAP's own n_jobs override.
# Pinning every threading layer to 1 thread before those libraries load is
# the only way to get bit-identical clustering across runs on the same
# input -- which matters a lot here, since folder names need to stay stable
# run to run. For a corpus this size (tens to low thousands of files) the
# single-threaded performance cost is negligible.
#
# NOTE (v3.6): this alone was never sufficient -- see the v3.6 changelog
# entry above. It's still correct to keep this pinning; it just wasn't the
# whole story.
for _env_var in (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMBA_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS",
):
    os.environ[_env_var] = "1"

import hashlib
import json
import logging
import traceback
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

# ----------------------------------------------------------------------------
# Logging -- MUST go to stderr. stdout is reserved for the single JSON result
# the Node process parses.
# ----------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [clusterV3.py] %(levelname)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("clusterV3")

# ----------------------------------------------------------------------------
# Config -- tunable starting points, not fixed constants. Override per-run by
# passing a "config" object alongside "embeddings"/"texts" on stdin.
#
# Defaults carry over v2's hard-won small-corpus tuning (min_cluster_size=2,
# 'eom' selection, etc.). BERTopic's own defaults (min_topic_size=10,
# n_neighbors=15) are tuned for thousands of docs and will collapse ~100 files
# into one topic + a pile of outliers, so DO NOT just use BERTopic defaults.
# ----------------------------------------------------------------------------
DEFAULT_CONFIG: Dict[str, Any] = {
    # UMAP (BERTopic's dimensionality-reduction stage)
    "umap_n_neighbors": 15,      # clamped to n-1 for tiny batches
    "umap_n_components": 10,      # BERTopic canonical; v2 used 12 -- try 5-12
    "umap_metric": "cosine",
    "umap_min_dist": 0.0,        # BERTopic-recommended for clustering (tight groups)
    "umap_random_state": 42,     # fixed: folder names must be stable across runs
    # NEW (v3.6): 'spectral' (the UMAP/BERTopic default) uses an ARPACK
    # eigensolver that is well-documented to be numerically unstable on
    # near-degenerate input -- see https://github.com/rapidsai/cuml/issues/6696
    # ("UMAP produces unstable representations with spectral initialization
    # and fixed random state"). Near-duplicate files (multiple resume
    # versions, repeated VedicReport exports) are exactly that kind of
    # near-degenerate structure. 'pca' is a fully deterministic, natively
    # supported alternative. Since this pipeline's hard requirement is
    # "same files -> same folders" (stability), not maximum layout fidelity,
    # 'pca' is now the default. Set back to "spectral" to compare quality
    # once you've confirmed order-canonicalization alone fixed things.
    "umap_init": "pca",

    # HDBSCAN
    "min_cluster_size": 8,       # == BERTopic min_topic_size; keep small at n~100
    "min_samples": 3,         # v3.2 tried 5 (pulled toward min_cluster_size) to
                               # discourage weak-bridge merging. Reverted in v3.3:
                               # evidence showed it pushed a legitimate small
                               # cluster (VedicReports + personal misc, ~15 files)
                               # below HDBSCAN's density bar into noise, which
                               # reduce_outliers' threshold-free reassignment then
                               # force-fit into the nearest *unrelated* big
                               # cluster -- recreating a mega-blob through a
                               # different mechanism than the one v3.2 "fixed".
    "cluster_selection_method": "eom",  # v2 found 'eom' beat 'leaf' after UMAP
    "cluster_selection_epsilon": 0.0,   # >0 merges clusters closer than this distance
                                         # in HDBSCAN's own space; another lever if
                                         # grab-bag clusters persist.

    # c-TF-IDF / vectorizer
    "ctfidf_ngram_range": (1, 2),
    "ctfidf_reduce_frequent_words": True,  # BERTopic ClassTfidfTransformer option
    "ctfidf_top_k": 7,
    # v2's greedy diversity: two candidate keywords are redundant if they share
    # this fraction (or more) of their crudely-stemmed words.
    "ctfidf_word_overlap_threshold": 0.5,

    # Topic-level merge (OFF by default -- see v3.2 note above). On a real
    # ~190-file run this fused an administrative/financial topic with an
    # unrelated personal-misc/astrology topic (aggregate vocabulary looked
    # >=0.9 similar) while STILL failing to merge the actual near-duplicate
    # topics (two separate resume clusters, two separate "Chapter 6"
    # clusters) it was meant to catch. Left available for experimentation,
    # but `merge_near_duplicate_clusters` below is the recommended mechanism
    # for the "same document filed twice" problem.
    "reduce_topics": False,
    "nr_topics": "auto",

    # Outlier reduction (== v2 Stage 4 reattach + Stage 5 regroup)
    "reduce_outliers": True,
    # "embeddings" is the most robust with precomputed vectors and needs no
    # threshold tuning. Others: "c-tf-idf", "distributions", "probabilities".
    "outlier_reduce_strategy": "embeddings",
    "outlier_reduce_threshold": 0.05,  # used by c-tf-idf/distributions/probabilities

    # Outlier-reassignment distance guard (v3.3). The "embeddings" strategy
    # above has NO distance threshold -- it always force-assigns every noise
    # point to its single closest cluster, even when that closest match is
    # still a poor fit. In testing this is exactly what rebuilt a
    # financial-documents+astrology-reports mega-cluster: once a small
    # legitimate cluster got pushed into noise, its members got force-fit
    # into the nearest big (but thematically unrelated) cluster. This guard
    # walks back any reassignment that lands further from its new cluster's
    # centroid than outlier_reassign_max_zscore standard deviations beyond
    # that cluster's OWN typical member spread (computed only from the
    # cluster's original, non-reassigned members, so one bad reassignment
    # can't loosen the bar for the next one). Rejected points revert to -1
    # (Uncategorized) instead of polluting an unrelated cluster.
    "validate_outlier_reassignments": True,
    "outlier_reassign_max_zscore": 2.0,

    # Near-duplicate cluster merge (v3.2). Runs AFTER outlier reduction.
    # Merges two clusters if any single pair of member files (one in each)
    # has raw embedding cosine similarity >= duplicate_merge_similarity --
    # i.e. strong file-level evidence they're the same document. This is
    # deliberately narrower/safer than topic-level (bag-of-words) merging.
    # duplicate_report_similarity is a lower threshold used ONLY for stderr
    # logging / the duplicateCandidates output, so you can calibrate the
    # merge threshold against real similarity values from your own model.
    "merge_near_duplicate_clusters": True,
    "duplicate_merge_similarity": 0.92,
    "duplicate_report_similarity": 0.80,
    # NEW (v3.6): a single cross-cluster pair >= duplicate_merge_similarity
    # is only allowed to union two clusters if at least ONE side is still
    # small (<= min_cluster_size * this multiple) -- i.e. looks like a
    # duplicate-fragment cluster, not an independently-substantial topic.
    # This is what stops one coincidental high-similarity pair from welding
    # two big, unrelated topics together (the administrative+VedicReport
    # mega-cluster mechanism). Raise this if legitimate merges start getting
    # rejected; lower it if big topics are still getting welded together.
    "duplicate_merge_min_side_cap_multiple": 1.5,
    # How many cross-cluster candidate pairs to include in the JSON output's
    # "duplicateCandidates" list (highest-similarity first). This is your
    # calibration window when stderr logs aren't reachable (e.g. spawned
    # from Node without piping stderr) -- inspect it directly in the result.
    "duplicate_candidates_limit": 50,

    # Per-cluster "off-theme" flag feeding the Node outlierNote. A member is
    # flagged if its distance to the cluster centroid exceeds mean + z*std.
    "outlier_zscore": 1.5,

    # Representatives (Core->Edge spread)
    "max_representatives": 4,
}

# Layered on top of sklearn's English stopwords. Extend with boilerplate that
# shows up in YOUR extracted text.
CUSTOM_STOPWORDS = {
    "page", "confidential", "draft", "untitled", "copy", "copyright",
    "reserved", "rights", "table", "contents", "click", "here",
    "http", "https", "www", "com", "pdf", "doc", "docx", "xlsx", "pptx",
    "figure", "appendix", "index", "chapter", "section", "attachment",
    "attachments", "inc", "llc", "ltd",
}


# ============================================================================
# Pure-numpy helpers (no BERTopic dependency) -- unit-testable in isolation.
# ============================================================================
def normalize_vectors(X: np.ndarray) -> np.ndarray:
    """Unit-normalize rows. Node already L2-normalizes, but re-doing it here
    makes the script safe to run on raw vectors too, and cosine == dot."""
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return X / norms


def compute_canonical_order(
    file_ids: Optional[List[str]], X: np.ndarray, texts: Optional[List[str]]
) -> Tuple[List[int], List[str]]:
    """Return (perm, sorted_keys): a permutation of original indices that
    sorts the input into a fixed, content-derived order -- independent of
    whatever order the caller (Node) happened to hand items in this run.

    WHY THIS EXISTS (v3.6): comparing embeddings.json between two runs on an
    unchanged file set showed the SAME vectors present both times (no value
    changed) but in a DIFFERENT ORDER. UMAP's neighbor-graph construction and
    spectral initialization are not guaranteed order-invariant -- especially
    with near-duplicate vectors, where tie-breaking in nearest-neighbor
    search and eigenvector computation can depend on which index came first.
    Reordering the input can therefore change the clustering even when the
    SET of files is identical. Sorting into a fixed canonical order before
    UMAP/HDBSCAN removes input order as a variable entirely; the caller's
    original order is restored on the way out (see restore_original_order),
    so the stdin/stdout contract is unaffected.

    Preferred key: `file_ids[i]`, a stable per-file identity that shouldn't
    depend on scan order (make sure Node assigns it from something stable,
    e.g. an absolute path or content hash -- NOT a scan-order counter, which
    would defeat the whole point). Falls back to a hash of the (rounded)
    embedding vector, then the file's text, if fileIds aren't supplied
    (legacy input mode). The fallback can't fully distinguish two files with
    byte-identical embeddings AND texts; in that rare case the relative
    order between just those two files is still whatever the input gave,
    which is harmless since the pipeline can't distinguish them anyway.
    """
    n = len(X)

    def fallback_key(i: int) -> str:
        rounded = np.round(np.asarray(X[i], dtype=np.float64), 6)
        h = hashlib.sha256(rounded.tobytes()).hexdigest()
        if texts is not None:
            h += "|" + hashlib.sha256((texts[i] or "").encode("utf-8", "ignore")).hexdigest()
        return h

    if file_ids is not None and len(file_ids) == n:
        keys = [str(file_ids[i]) for i in range(n)]
    else:
        keys = [fallback_key(i) for i in range(n)]

    perm = sorted(range(n), key=lambda i: keys[i])
    sorted_keys = [keys[i] for i in perm]
    return perm, sorted_keys


def compute_input_fingerprint(sorted_keys: List[str]) -> str:
    """Short, stable hash of the canonicalized-order key list. Two runs on
    the same file set (same fileIds/embeddings) will produce the SAME
    fingerprint regardless of what order Node handed the data in. If two
    runs on files you believe are unchanged produce DIFFERENT fingerprints,
    the drift is upstream of this script (Node's scan/embedding step), not
    inside UMAP/HDBSCAN -- no need to keep re-diffing raw embeddings by hand
    to check that."""
    h = hashlib.sha256()
    for k in sorted_keys:
        h.update(k.encode("utf-8", "ignore"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


def restore_original_order(
    result: Dict[str, Any], perm: List[int], had_file_ids: bool
) -> Dict[str, Any]:
    """Undo compute_canonical_order's permutation on every positional field
    in the result, so the output lines up with the ORIGINAL input order the
    caller sent -- clustering ran on a canonical order internally, but
    Node's side of the contract never has to know that."""
    n = len(perm)

    original_labels: List[Optional[int]] = [None] * n
    for k, orig_idx in enumerate(perm):
        original_labels[orig_idx] = result["labels"][k]
    result["labels"] = original_labels

    result["representatives"] = {
        cid: [perm[k] for k in positions]
        for cid, positions in result["representatives"].items()
    }

    fd = result["fileDiagnostics"]
    new_fd: Dict[str, Any] = {}
    for key, val in fd.items():
        if key == "_pipeline":
            new_fd["_pipeline"] = val
            continue
        new_fd[str(perm[int(key)])] = val
    result["fileDiagnostics"] = new_fd

    if not had_file_ids:
        # duplicateCandidates' fileA/fileB are raw canonical-order indices
        # in this mode (no stable string id available); map back to the
        # original positions the caller sent, so they still mean "index N
        # of the array I gave you," as documented.
        for cand in result["duplicateCandidates"]:
            cand["fileA"] = perm[cand["fileA"]]
            cand["fileB"] = perm[cand["fileB"]]
    # else: fileA/fileB are already fileId strings -- stable regardless of
    # internal ordering, no remapping needed.

    return result


def _word_set(term: str) -> set:
    """Crude stemming (strip trailing 's') -- enough to catch invoice/invoices
    duplication without pulling in nltk. Ported verbatim from v2."""
    return {w.rstrip("s") for w in term.split()}


def diversify_keywords(words: List[str], top_k: int, overlap_threshold: float) -> List[str]:
    """Greedy word-overlap dedup over c-TF-IDF-ranked words (v2 Stage 7 logic),
    applied to BERTopic's get_topic() output. `words` must already be ranked
    best-first, which BERTopic guarantees."""
    selected: List[str] = []
    selected_sets: List[set] = []
    for term in words:
        if not term:
            continue
        tw = _word_set(term)
        redundant = any(
            len(tw & prior) / max(len(tw), 1) >= overlap_threshold
            for prior in selected_sets
        )
        if redundant:
            continue
        selected.append(term)
        selected_sets.append(tw)
        if len(selected) >= top_k:
            break
    return selected


def compute_representatives(
    X: np.ndarray, labels: np.ndarray, max_representatives: int = 4
) -> Dict[str, List[int]]:
    """Up to `max_representatives` member indices per cluster, evenly spread
    from Core (closest to centroid) to Edge (farthest). Uses FULL-dimensional
    normalized embeddings, not any reduced space -- picking "most typical vs
    most atypical real file" is more trustworthy in the original space.
    Ported verbatim from v2."""
    reps: Dict[str, List[int]] = {}
    for cluster_id in sorted(set(labels.tolist())):
        if cluster_id == -1:
            continue
        idx = np.where(labels == cluster_id)[0]
        centroid = X[idx].mean(axis=0)
        dists = np.linalg.norm(X[idx] - centroid, axis=1)
        order = np.argsort(dists)  # ascending: Core first
        if len(order) <= max_representatives:
            selected = order
        else:
            positions = np.linspace(0, len(order) - 1, max_representatives)
            selected = order[np.round(positions).astype(int)]
        reps[str(cluster_id)] = [int(idx[i]) for i in selected]
    return reps


def per_file_centroid_distances(X: np.ndarray, labels: np.ndarray) -> Dict[int, float]:
    out: Dict[int, float] = {}
    for cluster_id in sorted(set(labels.tolist())):
        if cluster_id == -1:
            continue
        idx = np.where(labels == cluster_id)[0]
        centroid = X[idx].mean(axis=0)
        for j in idx:
            out[int(j)] = float(np.linalg.norm(X[j] - centroid))
    return out


def compute_cluster_outlier_counts(
    X: np.ndarray, labels: np.ndarray, zscore: float = 1.5
) -> Dict[str, int]:
    """Per-cluster count of members that sit notably far from the centroid
    (distance > mean + z*std). This is what fileClassificationTool.ts reads as
    `outlierCounts[label]` to decide whether to warn the naming LLM that some
    files 'may be off-theme'. Clusters with <3 members can't have a meaningful
    spread, so they report 0."""
    counts: Dict[str, int] = {}
    for cluster_id in sorted(set(labels.tolist())):
        if cluster_id == -1:
            continue
        idx = np.where(labels == cluster_id)[0]
        if len(idx) < 3:
            counts[str(cluster_id)] = 0
            continue
        centroid = X[idx].mean(axis=0)
        dists = np.linalg.norm(X[idx] - centroid, axis=1)
        std = float(dists.std())
        threshold = float(dists.mean() + zscore * std) if std > 0 else np.inf
        counts[str(cluster_id)] = int(np.sum(dists > threshold))
    return counts


def build_file_diagnostics(
    X: np.ndarray,
    initial_labels: np.ndarray,
    final_labels: np.ndarray,
    bertopic_noise: int,
    topics_merged: int,
    duplicate_clusters_merged: int,
    reduced: int,
    outlier_reassign_reverted: int = 0,
) -> Dict[str, Any]:
    dists = per_file_centroid_distances(X, final_labels)
    diag: Dict[str, Any] = {}
    for i in range(len(final_labels)):
        cid = int(final_labels[i])
        if cid == -1:
            diag[str(i)] = {"resolvedAt": "uncategorized"}
        else:
            diag[str(i)] = {
                "resolvedAt": "bertopic_primary" if int(initial_labels[i]) != -1 else "outlier_reduced",
                "cluster": cid,
                "distanceToCentroid": round(dists.get(i, 0.0), 4),
            }
    diag["_pipeline"] = {
        "bertopic_noise": int(bertopic_noise),
        "topics_merged": int(topics_merged),
        "duplicate_clusters_merged": int(duplicate_clusters_merged),
        "reduced": int(reduced),
        "outlier_reassign_reverted": int(outlier_reassign_reverted),
        "final_uncategorized": int(np.sum(final_labels == -1)),
        "nTopics": len(set(final_labels.tolist()) - {-1}),
    }
    return diag


# ============================================================================
# BERTopic core
# ============================================================================
def build_topic_model(X_norm: np.ndarray, config: Dict[str, Any]):
    """Construct a BERTopic tuned for small (~100 doc) corpora with precomputed
    embeddings. Imports are local so a missing dependency yields a clear error
    only when this path actually runs."""
    try:
        from bertopic import BERTopic
        from bertopic.vectorizers import ClassTfidfTransformer
        from umap import UMAP
        from hdbscan import HDBSCAN
        from sklearn.feature_extraction.text import CountVectorizer, ENGLISH_STOP_WORDS
    except ImportError as e:
        raise RuntimeError(
            "BERTopic and its deps are required (pip install bertopic). "
            f"Import failed: {e}"
        ) from e

    n = len(X_norm)
    # UMAP needs n_neighbors < n and n_components < n. Clamp for tiny batches.
    n_neighbors = int(min(config["umap_n_neighbors"], max(2, n - 1)))
    n_components = int(min(config["umap_n_components"], max(2, n - 2)))

    umap_model = UMAP(
        n_neighbors=n_neighbors,
        n_components=n_components,
        min_dist=config["umap_min_dist"],
        metric=config["umap_metric"],
        random_state=config["umap_random_state"],
        init=config.get("umap_init", "pca"),  # v3.6: deterministic by default -- see
                                               # DEFAULT_CONFIG comment / v3.6 changelog.
        n_jobs=1,  # redundant with the env-var pinning above, but explicit
                   # beats implicit -- don't rely solely on umap-learn's
                   # internal random_state override, per the known issues
                   # linked at the top of this file.
    )
    hdbscan_model = HDBSCAN(
        min_cluster_size=config["min_cluster_size"],
        min_samples=config["min_samples"],
        metric="euclidean",
        cluster_selection_method=config["cluster_selection_method"],
        cluster_selection_epsilon=config.get("cluster_selection_epsilon", 0.0),
        prediction_data=True,
        core_dist_n_jobs=1,  # HDBSCAN's own core-distance computation can
                              # also multi-thread independently of UMAP;
                              # pin it too for full run-to-run stability.
    )
    stop_words = list(set(ENGLISH_STOP_WORDS) | CUSTOM_STOPWORDS)
    vectorizer_model = CountVectorizer(
        ngram_range=tuple(config["ctfidf_ngram_range"]),
        stop_words=stop_words,
        lowercase=True,
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9\-]+\b",
    )
    ctfidf_model = ClassTfidfTransformer(
        reduce_frequent_words=config["ctfidf_reduce_frequent_words"]
    )

    calc_probs = config["outlier_reduce_strategy"] == "probabilities"

    topic_model = BERTopic(
        umap_model=umap_model,
        hdbscan_model=hdbscan_model,
        vectorizer_model=vectorizer_model,
        ctfidf_model=ctfidf_model,
        embedding_model=None,          # embeddings are precomputed in Node
        top_n_words=max(30, config["ctfidf_top_k"]),  # headroom for diversity dedup
        calculate_probabilities=calc_probs,
        verbose=False,
    )
    return topic_model


def maybe_reduce_topics(
    topic_model, docs: List[str], topics: List[int], texts: Optional[List[str]], config: Dict[str, Any]
) -> Tuple[List[int], int]:
    """OFF by default -- see v3.2 note at top of file. Merges topics via
    BERTopic's c-TF-IDF-similarity topic reduction. Kept for experimentation
    only; prefer `merge_near_duplicate_clusters` for the "same document filed
    twice" problem."""
    n_before = len(set(topics) - {-1})
    if not config.get("reduce_topics") or texts is None or n_before < 2:
        return topics, 0
    try:
        nr_topics = config.get("nr_topics", "auto")
        topic_model.reduce_topics(docs, nr_topics=nr_topics)
        new_topics = list(topic_model.topics_)
        n_after = len(set(new_topics) - {-1})
        merged = max(0, n_before - n_after)
        logger.info("reduce_topics(nr_topics=%s): %d topic(s) -> %d (merged %d).",
                    nr_topics, n_before, n_after, merged)
        return new_topics, merged
    except Exception as e:  # noqa: BLE001 - non-fatal; keep pre-merge topics
        logger.warning("reduce_topics failed (%s); keeping original topics.", e)
        return topics, 0


def reduce_outliers_dispatch(
    topic_model, docs: List[str], topics: List[int], X_norm: np.ndarray, config: Dict[str, Any]
) -> List[int]:
    strategy = config["outlier_reduce_strategy"]
    threshold = config["outlier_reduce_threshold"]
    if strategy == "embeddings":
        return topic_model.reduce_outliers(
            docs, topics, strategy="embeddings", embeddings=np.asarray(X_norm)
        )
    if strategy == "probabilities":
        return topic_model.reduce_outliers(
            docs, topics, strategy="probabilities",
            probabilities=topic_model.probabilities_, threshold=threshold,
        )
    # "c-tf-idf" or "distributions"
    return topic_model.reduce_outliers(docs, topics, strategy=strategy, threshold=threshold)


def validate_outlier_reassignments(
    X: np.ndarray,
    pre_labels: np.ndarray,
    post_labels: List[int],
    max_zscore: float = 2.0,
) -> Tuple[List[int], int]:
    """Walk back any reduce_outliers reassignment that lands too far from its
    new cluster's centroid to be a believable member -- see v3.3 note at the
    top of this file. Cluster spread (mean/std of member-to-centroid
    distance) is computed ONLY from each cluster's ORIGINAL members (i.e.
    `pre_labels`, before this round of reassignment), so accepting one
    borderline point can't loosen the bar for the next one. Clusters with
    fewer than 2 original members can't have a meaningful spread and are
    trusted as-is (nothing to compare against). Returns (validated_labels,
    number_reverted_to_uncategorized).
    """
    post = list(post_labels)
    original_members: Dict[int, List[int]] = {}
    for i, lbl in enumerate(pre_labels.tolist()):
        if lbl != -1:
            original_members.setdefault(int(lbl), []).append(i)

    stats: Dict[int, Tuple[np.ndarray, float, float]] = {}
    for cid, idx in original_members.items():
        if len(idx) < 2:
            continue
        centroid = X[idx].mean(axis=0)
        dists = np.linalg.norm(X[idx] - centroid, axis=1)
        stats[cid] = (centroid, float(dists.mean()), float(dists.std()))

    reverted = 0
    for i in range(len(post)):
        pre = int(pre_labels[i])
        new = post[i]
        if pre != -1 or new == -1 or new not in stats:
            continue  # wasn't noise, stayed noise, or nothing to validate against
        centroid, mean_d, std_d = stats[new]
        d = float(np.linalg.norm(X[i] - centroid))
        cutoff = mean_d + max_zscore * std_d if std_d > 0 else mean_d * 1.5
        if d > cutoff:
            post[i] = -1
            reverted += 1
    return post, reverted


def _cross_cluster_similarity_pairs(
    X: np.ndarray, labels: np.ndarray, min_report_threshold: float
) -> List[Tuple[int, int, float]]:
    """All (i, j, cosine_similarity) pairs where file i and file j sit in
    different, non-noise clusters and similarity >= min_report_threshold,
    sorted highest-first. X must be unit-normalized (cosine == dot product)."""
    n = len(labels)
    if n == 0:
        return []
    if n > 4000:
        logger.warning(
            "Skipping cross-cluster similarity scan for n=%d files (O(n^2) too costly "
            "at this size); near-duplicate cluster merging disabled for this run.", n
        )
        return []
    sims = X @ X.T
    pairs: List[Tuple[int, int, float]] = []
    for i in range(n):
        li = int(labels[i])
        if li == -1:
            continue
        row = sims[i]
        for j in range(i + 1, n):
            lj = int(labels[j])
            if lj == -1 or lj == li:
                continue
            s = float(row[j])
            if s >= min_report_threshold:
                pairs.append((i, j, s))
    pairs.sort(key=lambda t: -t[2])
    return pairs


class _ClusterUnionFind:
    """Union-find keyed by original cluster label (not file index)."""

    def __init__(self, cluster_ids: List[int]):
        self.parent: Dict[int, int] = {c: c for c in cluster_ids}

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            hi, lo = max(ra, rb), min(ra, rb)  # deterministic: lower id survives
            self.parent[hi] = lo


def merge_near_duplicate_clusters(
    X: np.ndarray,
    labels: np.ndarray,
    merge_threshold: float,
    report_threshold: float,
    min_cluster_size: int,
    min_side_cap_multiple: float,
) -> Tuple[np.ndarray, int, List[Tuple[int, int, float]], List[Tuple[int, int, float]], int]:
    """Merge whole clusters together when there's hard per-document evidence
    they should be one: at least one pair of member files (in DIFFERENT
    clusters) whose raw embedding cosine similarity is >= merge_threshold --
    i.e. very likely the same document (a resume revision, a re-exported
    report, a duplicate assignment upload). See v3.2 note at top of file for
    why this replaced topic-level (bag-of-words) merging as the default.

    NEW (v3.6): a union is only allowed if at least one of the two clusters
    is still small (<= min_cluster_size * min_side_cap_multiple members) --
    i.e. looks like a duplicate-fragment cluster rather than an
    independently-substantial topic. Without this guard, a single
    coincidentally-high-similarity pair between two large, otherwise
    unrelated clusters can weld them into one mega-cluster via transitive
    union-find (classic single-linkage chaining) -- which is what kept
    reassembling the administrative+VedicReport blob. Rejected candidates
    are still reported (not silently dropped) so you can review them.

    Also logs every cross-cluster pair down to report_threshold (even ones
    that don't merge) so you can calibrate the threshold against real
    similarity values from your own embeddings -- and returns that same
    pair list so the caller can surface it in the JSON result too (useful
    when stderr isn't reachable, e.g. spawned from Node without piping it).

    Returns (validated_labels, merged_cluster_pair_count, merges_applied,
    all_candidate_pairs, rejected_by_size_cap_count).
    """
    report_threshold = min(merge_threshold, report_threshold)
    pairs = _cross_cluster_similarity_pairs(X, labels, report_threshold)

    for i, j, s in pairs[:25]:
        tag = "MERGE" if s >= merge_threshold else "below threshold"
        logger.info(
            "cross-cluster similarity: file[%d] (cluster %s) <-> file[%d] (cluster %s) sim=%.3f [%s]",
            i, int(labels[i]), j, int(labels[j]), s, tag,
        )

    cluster_ids = sorted(set(int(l) for l in labels if l != -1))
    if len(cluster_ids) < 2 or not pairs:
        return labels, 0, [], pairs, 0

    uf = _ClusterUnionFind(cluster_ids)
    sizes: Dict[int, int] = {cid: int(np.sum(labels == cid)) for cid in cluster_ids}
    cap = max(min_cluster_size, 1) * min_side_cap_multiple

    merges_applied: List[Tuple[int, int, float]] = []
    rejected_size_cap = 0
    for i, j, s in pairs:
        if s < merge_threshold:
            break  # pairs is sorted descending; nothing further qualifies
        li, lj = int(labels[i]), int(labels[j])
        ri, rj = uf.find(li), uf.find(lj)
        if ri == rj:
            continue
        smaller_side = min(sizes[ri], sizes[rj])
        if smaller_side > cap:
            # Both clusters already look like substantial, independent
            # topics -- one high-similarity file pair is weak evidence for
            # welding them together. Leave for manual review instead.
            rejected_size_cap += 1
            continue
        uf.union(ri, rj)
        new_root = uf.find(ri)
        sizes[new_root] = sizes[ri] + sizes[rj]
        merges_applied.append((li, lj, s))

    new_labels = labels.copy()
    for idx in range(len(labels)):
        if labels[idx] != -1:
            new_labels[idx] = uf.find(int(labels[idx]))

    n_after = len(set(int(l) for l in new_labels if l != -1))
    merged_count = len(cluster_ids) - n_after
    return new_labels, merged_count, merges_applied, pairs, rejected_size_cap


def extract_keywords(
    topic_model, labels: np.ndarray, texts: Optional[List[str]], config: Dict[str, Any]
) -> Dict[str, List[str]]:
    cluster_ids = sorted(set(int(l) for l in labels if l != -1))
    if texts is None:
        return {str(c): [] for c in cluster_ids}

    top_k = config["ctfidf_top_k"]
    overlap = config["ctfidf_word_overlap_threshold"]
    keywords: Dict[str, List[str]] = {}
    for cid in cluster_ids:
        topic = topic_model.get_topic(cid)
        words = [w for (w, _score) in topic] if topic else []
        keywords[str(cid)] = diversify_keywords(words, top_k, overlap)
    return keywords


# ============================================================================
# Orchestration
# ============================================================================
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
        raise ValueError("Input JSON must be an array of embeddings or an object.")

    if embeddings is None:
        raise ValueError("No 'embeddings' found in input.")

    X = np.array(embeddings, dtype=np.float64)

    if texts is not None and len(texts) != len(embeddings):
        logger.warning(
            "'texts' length (%d) != 'embeddings' length (%d); ignoring texts.",
            len(texts), len(embeddings),
        )
        texts = None

    # All-blank texts would crash CountVectorizer with an empty vocabulary;
    # treat as no-text (clustering still runs, keywords come back empty).
    if texts is not None and not any((t or "").strip() for t in texts):
        logger.warning("All 'texts' are blank; proceeding without keyword extraction.")
        texts = None

    # NEW (v3.6): a length mismatch here would previously fall back to raw
    # index silently (see old _fid behavior) -- meaning a fileIds/embeddings
    # desync could misattribute every file to the wrong id with NO visible
    # error. Fail loudly instead; fix the caller rather than guess a
    # pairing.
    if file_ids is not None and len(file_ids) != len(embeddings):
        raise ValueError(
            f"'fileIds' length ({len(file_ids)}) != 'embeddings' length ({len(embeddings)}). "
            "Refusing to guess a pairing -- check the Node-side step that assembles "
            "embeddings/fileIds for a possible desync (e.g. two separately-resolved "
            "async arrays that don't preserve correspondence)."
        )
    if file_ids is not None:
        seen: Dict[str, int] = {}
        for fid in file_ids:
            seen[fid] = seen.get(fid, 0) + 1
        dupes = [k for k, c in seen.items() if c > 1]
        if dupes:
            logger.warning(
                "Duplicate fileIds in input (%d distinct id(s) appear more than once, "
                "e.g. %r) -- check the Node-side file scan/embedding step for "
                "double-counted files.", len(dupes), dupes[:5],
            )

    return X, texts, file_ids, config


def _refresh_ctfidf(topic_model, docs: List[str], topics: List[int], config: Dict[str, Any]) -> None:
    """Recompute BERTopic's internal c-TF-IDF representation for a new label
    assignment, so get_topic() returns keywords that match the FINAL
    membership rather than whatever grouping existed when the model was
    fit. Cheap relative to fit_transform; safe to call more than once."""
    topic_model.update_topics(
        docs,
        topics=topics,
        vectorizer_model=topic_model.vectorizer_model,
        ctfidf_model=topic_model.ctfidf_model,
        top_n_words=max(30, config["ctfidf_top_k"]),
    )


def run_pipeline(
    X: np.ndarray, texts: Optional[List[str]], config: Dict[str, Any], file_ids: Optional[List[str]] = None
) -> Dict[str, Any]:
    X_norm = normalize_vectors(X)
    docs = texts if texts is not None else [f"document_{i}" for i in range(len(X))]

    topic_model = build_topic_model(X_norm, config)
    initial_topics, _ = topic_model.fit_transform(docs, embeddings=np.asarray(X_norm))
    initial = np.array(initial_topics)
    bertopic_noise = int(np.sum(initial == -1))
    logger.info(
        "BERTopic: %d topic(s), %d outlier(s) of %d docs.",
        len(set(initial_topics) - {-1}), bertopic_noise, len(X),
    )

    # --- Stage: topic-level merge (OFF by default -- see v3.2 note) -------
    stage_topics, topics_merged = maybe_reduce_topics(topic_model, docs, list(initial_topics), texts, config)

    # --- Stage: reassign noise points to their nearest real topic ---------
    reduced = 0
    has_real_clusters = len(set(stage_topics) - {-1}) > 0
    current_noise = int(np.sum(np.array(stage_topics) == -1))
    outlier_reassign_reverted = 0
    if config["reduce_outliers"] and current_noise > 0 and has_real_clusters:
        try:
            pre_outlier_labels = np.array(stage_topics)  # snapshot before this stage
            reassigned = reduce_outliers_dispatch(topic_model, docs, list(stage_topics), X_norm, config)
            if config.get("validate_outlier_reassignments", True):
                reassigned, outlier_reassign_reverted = validate_outlier_reassignments(
                    X_norm, pre_outlier_labels, reassigned,
                    max_zscore=config.get("outlier_reassign_max_zscore", 2.0),
                )
                if outlier_reassign_reverted:
                    logger.info(
                        "outlier reassignment guard: reverted %d weak-fit reassignment(s) back to Uncategorized.",
                        outlier_reassign_reverted,
                    )
            stage_topics = reassigned
            if texts is not None:
                _refresh_ctfidf(topic_model, docs, stage_topics, config)
            reduced = current_noise - int(np.sum(np.array(stage_topics) == -1))
            logger.info("reduce_outliers(%s): reassigned %d outlier(s) (net, after guard).",
                        config["outlier_reduce_strategy"], reduced)
        except Exception as e:  # noqa: BLE001 - non-fatal; keep prior labels
            logger.warning("reduce_outliers failed (%s); keeping pre-outlier-reduction labels.", e)

    stage_labels = np.array(stage_topics)

    # Safety net: if BERTopic found no real cluster at all (a known small-n
    # failure mode), don't hand Node an all-Uncategorized batch -- put
    # everything in one cluster so at least one folder gets named.
    if len(set(stage_labels.tolist()) - {-1}) == 0:
        logger.warning("No real clusters formed; falling back to a single cluster.")
        stage_labels = np.zeros(len(X), dtype=int)
        initial = stage_labels.copy()

    # --- Stage: near-duplicate cluster merge (v3.2, ON by default; size-cap
    #     guard added in v3.6) -------------------------------------------
    duplicate_clusters_merged = 0
    duplicate_candidate_pairs: List[Tuple[int, int, float]] = []
    duplicate_merges_rejected_size_cap = 0
    if config.get("merge_near_duplicate_clusters") and len(set(stage_labels.tolist()) - {-1}) > 1:
        try:
            (new_labels, duplicate_clusters_merged, _merges,
             duplicate_candidate_pairs, duplicate_merges_rejected_size_cap) = merge_near_duplicate_clusters(
                X_norm, stage_labels,
                merge_threshold=config["duplicate_merge_similarity"],
                report_threshold=config["duplicate_report_similarity"],
                min_cluster_size=config["min_cluster_size"],
                min_side_cap_multiple=config.get("duplicate_merge_min_side_cap_multiple", 1.5),
            )
            if duplicate_clusters_merged > 0:
                logger.info("near-duplicate merge: combined %d cluster pair(s) (threshold=%.2f).",
                            duplicate_clusters_merged, config["duplicate_merge_similarity"])
                if texts is not None:
                    _refresh_ctfidf(topic_model, docs, list(new_labels), config)
            if duplicate_merges_rejected_size_cap:
                logger.info(
                    "near-duplicate merge: rejected %d candidate cluster-pair merge(s) via "
                    "size-cap guard (both sides already looked like independent topics).",
                    duplicate_merges_rejected_size_cap,
                )
            stage_labels = new_labels
        except Exception as e:  # noqa: BLE001 - non-fatal; keep prior labels
            logger.warning("merge_near_duplicate_clusters failed (%s); keeping prior labels.", e)

    final = stage_labels

    def _fid(idx: int) -> Any:
        if file_ids is not None and idx < len(file_ids):
            return file_ids[idx]
        return idx

    limit = config.get("duplicate_candidates_limit", 50)
    duplicate_candidates = []
    for (i, j, s) in duplicate_candidate_pairs[:limit]:
        merged_flag = bool(int(final[i]) == int(final[j]) and int(final[i]) != -1)
        entry: Dict[str, Any] = {
            "fileA": _fid(i),
            "fileB": _fid(j),
            "similarity": round(s, 4),
            "merged": merged_flag,
        }
        if not merged_flag and s >= config["duplicate_merge_similarity"]:
            entry["note"] = "above merge threshold but rejected by size-cap guard (see v3.6)"
        duplicate_candidates.append(entry)

    keywords = extract_keywords(topic_model, final, texts, config)
    representatives = compute_representatives(X_norm, final, config["max_representatives"])
    outlier_counts = compute_cluster_outlier_counts(X_norm, final, config["outlier_zscore"])
    cluster_sizes = {
        str(c): int(np.sum(final == c))
        for c in sorted(set(final.tolist())) if c != -1
    }
    file_diagnostics = build_file_diagnostics(
        X_norm, initial, final, bertopic_noise, topics_merged, duplicate_clusters_merged,
        reduced, outlier_reassign_reverted,
    )
    file_diagnostics["_pipeline"]["duplicate_merges_rejected_size_cap"] = int(duplicate_merges_rejected_size_cap)

    return {
        "labels": final.tolist(),
        "representatives": representatives,
        "outlierCounts": outlier_counts,
        "keywords": keywords,
        "clusterSizes": cluster_sizes,
        "fileDiagnostics": file_diagnostics,
        "duplicateCandidates": duplicate_candidates,
    }


def main() -> None:
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps([]))
            return

        X, texts, file_ids, config = parse_input(input_data)

        if X.size == 0:
            print(json.dumps([]))
            return

        # Single file: nothing to cluster. No ordering concerns at n=1.
        if len(X) == 1:
            print(json.dumps({
                "labels": [0],
                "representatives": {"0": [0]},
                "outlierCounts": {"0": 0},
                "keywords": {"0": []},
                "clusterSizes": {"0": 1},
                "fileDiagnostics": {
                    "0": {"resolvedAt": "bertopic_primary", "cluster": 0, "distanceToCentroid": 0.0},
                    "_pipeline": {"bertopic_noise": 0, "topics_merged": 0, "duplicate_clusters_merged": 0,
                                  "reduced": 0, "outlier_reassign_reverted": 0,
                                  "final_uncategorized": 0, "nTopics": 1,
                                  "duplicate_merges_rejected_size_cap": 0},
                },
                "duplicateCandidates": [],
            }))
            return

        # --- v3.6: canonicalize input order before clustering, restore the
        # caller's original order before returning. See compute_canonical_order
        # docstring for why this exists. ---------------------------------
        perm, sorted_keys = compute_canonical_order(file_ids, X, texts)
        had_file_ids = file_ids is not None
        X_c = X[perm]
        texts_c = [texts[i] for i in perm] if texts is not None else None
        file_ids_c = [file_ids[i] for i in perm] if file_ids is not None else None

        result = run_pipeline(X_c, texts_c, config, file_ids=file_ids_c)
        result = restore_original_order(result, perm, had_file_ids)
        result["fileDiagnostics"]["_pipeline"]["inputFingerprint"] = compute_input_fingerprint(sorted_keys)

        print(json.dumps(result))

    except Exception as e:  # noqa: BLE001 - top-level guard, intentional
        logger.error("Pipeline failed: %s", e)
        logger.error(traceback.format_exc())
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()