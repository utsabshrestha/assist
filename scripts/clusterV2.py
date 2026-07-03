import sys
import json
import numpy as np
from scipy.spatial.distance import pdist, cdist
from sklearn.cluster import AgglomerativeClustering

MIN_THRESHOLD = 0.20
MAX_THRESHOLD = 0.45
DEFAULT_THRESHOLD = 0.35
MIN_SAMPLES_FOR_ADAPTIVE = 5
PERCENTILE = 17.5
MIN_CLUSTER_SIZE = 2
REASSIGN_TOLERANCE_MULTIPLIER = 1.0
MAX_CLUSTERS = 15
MAX_REPRESENTATIVES = 8
REPRESENTATIVES_PER_FILES = 10
OUTLIER_DISTANCE_MULTIPLIER = 1.5

# --- New tunables for the changes below ---
# Per-cluster rescue tolerance = median(in-cluster distance to centroid) * this multiplier.
# Replaces reusing the single global threshold for every cluster regardless of density.
RESCUE_DENSITY_MULTIPLIER = 1.5
# Never rescue tighter than this fraction of the global threshold (protects very
# homogeneous 2-file clusters from having a near-zero tolerance) or looser than this
# multiple of it (keeps the original outlier-safety the global threshold provided).
RESCUE_TOLERANCE_FLOOR = 0.5
RESCUE_TOLERANCE_CEILING = 2.0
# Relaxation applied ONLY when checking whether two+ orphaned singletons agree with
# EACH OTHER (not when attaching a lone orphan to an existing large cluster, which
# stays at REASSIGN_TOLERANCE_MULTIPLIER=1.0 for the reason in the comment below).
ORPHAN_MERGE_MULTIPLIER = 1.3
# cap_cluster_count refuses to force-merge two clusters whose centroids are farther
# apart than threshold * this multiplier, even if it means exceeding MAX_CLUSTERS.
CAP_MERGE_MAX_MULTIPLIER = 2.0


def l2_normalize(vectors):
    """Normalize rows to unit length before averaging. Cosine *distance* between two
    already-computed vectors is scale-invariant, so this doesn't matter for a single
    pairwise comparison — but a centroid is a MEAN of several vectors, and if those
    vectors have unequal magnitude, the raw arithmetic mean is pulled toward whichever
    points happen to be longer, skewing the centroid's direction. Normalizing first
    gives a proper spherical mean, which is what cosine-based centroid math assumes."""
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1e-10
    return vectors / norms


def compute_adaptive_threshold(X):
    """Derive a distance_threshold from the corpus's own pairwise cosine distance
    distribution, instead of a single fixed cutoff. A tight/homogenous corpus yields
    a small threshold (finer clusters); a diverse corpus yields a larger one (coarser
    clusters), preventing both over-fragmentation and over-merging."""
    if len(X) < MIN_SAMPLES_FOR_ADAPTIVE:
        return DEFAULT_THRESHOLD

    distances = pdist(X, metric='cosine')
    threshold = float(np.percentile(distances, PERCENTILE))
    return max(MIN_THRESHOLD, min(MAX_THRESHOLD, threshold))


def merge_orphan_clusters(X, labels, threshold):
    """Two singleton points that are genuinely similar to EACH OTHER, but not close
    enough to any existing large cluster, currently just sit as two separate -1s
    forever, because reassign_small_clusters only ever checks orphans against
    large-cluster centroids. This gives orphans a chance to form their own small
    cluster first.

    Note: this can't reuse the plain global `threshold` — if two never-merged
    singletons were within that distance of each other, the original fit_predict
    would already have merged them (agglomerative clustering processes every
    below-threshold merge in increasing distance order before stopping). So this
    step needs its own, slightly relaxed threshold to find anything at all. That
    relaxation is safe here in a way it wasn't for the tolerance you already tried
    and reverted for large-cluster attachment: it requires mutual agreement between
    2+ independent orphan points forming a new cluster together, not one ambiguous
    point being pulled onto an existing, unrelated centroid.
    """
    labels = labels.copy()
    unique_labels, counts = np.unique(labels, return_counts=True)
    small_labels = unique_labels[counts < MIN_CLUSTER_SIZE]

    orphan_mask = np.isin(labels, small_labels)
    orphan_indices = np.where(orphan_mask)[0]
    if len(orphan_indices) < MIN_CLUSTER_SIZE:
        return labels

    X_orphans = X[orphan_indices]
    sub_clusterer = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=threshold * ORPHAN_MERGE_MULTIPLIER,
        metric='cosine',
        linkage='average'
    )
    sub_labels = sub_clusterer.fit_predict(X_orphans)

    next_label = int(labels.max()) + 1
    sub_unique, sub_counts = np.unique(sub_labels, return_counts=True)
    for sub_lbl, cnt in zip(sub_unique, sub_counts):
        if cnt >= MIN_CLUSTER_SIZE:
            member_positions = orphan_indices[sub_labels == sub_lbl]
            labels[member_positions] = next_label
            next_label += 1

    return labels


def reassign_small_clusters(X, labels, threshold):
    """Clusters smaller than MIN_CLUSTER_SIZE are too small to be a meaningful category.
    Merge them into their nearest neighboring cluster, but using a tolerance derived
    from THAT cluster's own internal spread rather than the single global
    distance_threshold. The global threshold was calibrated against average-linkage
    distances computed incrementally while clusters were still forming; by the time a
    cluster reaches its final shape, a point can be a very reasonable fit for it while
    still sitting just above that reused global number. Checking against each
    cluster's own density (how tightly its existing members already sit around its
    centroid) is a closer match to "would this point look normal inside this cluster"
    than a single corpus-wide cutoff — and still keeps the original outlier-safety
    (an unrelated business pitch near a cluster of ML papers, at ~0.43 cosine distance)
    via the floor/ceiling bounds.
    """
    labels = labels.copy()
    unique_labels, counts = np.unique(labels, return_counts=True)
    small_labels = unique_labels[counts < MIN_CLUSTER_SIZE]
    large_labels = unique_labels[counts >= MIN_CLUSTER_SIZE]

    if len(small_labels) == 0 or len(large_labels) == 0:
        return labels

    centroids = []
    cluster_tolerances = []
    for lbl in large_labels:
        member_points = X[labels == lbl]
        normalized_members = l2_normalize(member_points)
        centroid = normalized_members.mean(axis=0)
        centroids.append(centroid)

        member_dists = cdist(normalized_members, centroid.reshape(1, -1), metric='cosine').ravel()
        local_tolerance = float(np.median(member_dists)) * RESCUE_DENSITY_MULTIPLIER
        bounded_tolerance = min(
            max(local_tolerance, threshold * RESCUE_TOLERANCE_FLOOR),
            threshold * RESCUE_TOLERANCE_CEILING
        )
        cluster_tolerances.append(bounded_tolerance)

    centroids = np.array(centroids)
    cluster_tolerances = np.array(cluster_tolerances)

    for lbl in small_labels:
        member_indices = np.where(labels == lbl)[0]
        for idx in member_indices:
            point = l2_normalize(X[idx].reshape(1, -1))
            dists = cdist(point, centroids, metric='cosine')[0]
            nearest_idx = int(np.argmin(dists))
            if dists[nearest_idx] <= cluster_tolerances[nearest_idx]:
                labels[idx] = large_labels[nearest_idx]
            else:
                labels[idx] = -1

    return labels


def cap_cluster_count(X, labels, max_clusters, threshold):
    """If clustering still produced more than max_clusters real clusters, repeatedly
    merge the two closest clusters by centroid cosine distance until the count is at
    or below the cap — but only while those two closest clusters are still
    reasonably related (within CAP_MERGE_MAX_MULTIPLIER * threshold). Beyond that
    point, stop: it's better to surface more than max_clusters clean groups than to
    force genuinely unrelated topics together just to hit a target count.
    """
    labels = labels.copy()
    unique_labels = [l for l in np.unique(labels) if l != -1]
    merge_ceiling = threshold * CAP_MERGE_MAX_MULTIPLIER

    while len(unique_labels) > max_clusters:
        centroids = np.array([
            l2_normalize(X[labels == lbl]).mean(axis=0) for lbl in unique_labels
        ])
        dist_matrix = cdist(centroids, centroids, metric='cosine')
        np.fill_diagonal(dist_matrix, np.inf)
        i, j = np.unravel_index(np.argmin(dist_matrix), dist_matrix.shape)

        if dist_matrix[i, j] > merge_ceiling:
            break

        lbl_a, lbl_b = unique_labels[i], unique_labels[j]
        labels[labels == lbl_b] = lbl_a
        unique_labels = [l for l in np.unique(labels) if l != -1]

    return labels


def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            return

        embeddings = json.loads(input_data)

        if not embeddings or len(embeddings) == 0:
            print(json.dumps([]))
            return

        X = np.array(embeddings)

        if len(X) == 1:
            print(json.dumps([0]))
            return

        threshold = compute_adaptive_threshold(X)

        clusterer = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=threshold,
            metric='cosine',
            linkage='average'
        )

        labels = clusterer.fit_predict(X)
        labels = merge_orphan_clusters(X, labels, threshold)
        labels = reassign_small_clusters(X, labels, threshold)
        labels = cap_cluster_count(X, labels, MAX_CLUSTERS, threshold)

        representatives = {}
        outlier_counts = {}
        for cluster_id in sorted(set(labels)):
            if cluster_id == -1:
                continue
            cluster_indices = np.where(labels == cluster_id)[0]
            if len(cluster_indices) == 0:
                continue

            cluster_points = X[cluster_indices]
            # Normalize before computing centroid/distances so this stays consistent
            # with the cosine metric clustering was actually done in, instead of
            # picking representatives by raw Euclidean distance to an unnormalized mean.
            normalized_points = l2_normalize(cluster_points)
            centroid = normalized_points.mean(axis=0)
            distances = cdist(normalized_points, centroid.reshape(1, -1), metric='cosine').ravel()

            sorted_local_indices = distances.argsort()
            n = len(sorted_local_indices)

            sample_count = min(MAX_REPRESENTATIVES, max(4, n // REPRESENTATIVES_PER_FILES))

            if n <= sample_count:
                chosen_local_indices = sorted_local_indices
            else:
                spread_positions = np.linspace(0, n - 1, sample_count, dtype=int)
                chosen_local_indices = sorted_local_indices[spread_positions]

            chosen_global_indices = cluster_indices[chosen_local_indices].tolist()
            representatives[str(cluster_id)] = chosen_global_indices

            median_distance = float(np.median(distances))
            outlier_threshold = median_distance * OUTLIER_DISTANCE_MULTIPLIER
            outlier_local_indices = np.where(distances > outlier_threshold)[0]
            outlier_counts[str(cluster_id)] = int(len(outlier_local_indices))

        # Diagnostics: for every file that ended up -1, record its nearest real
        # cluster and how far it was, so you can tell "true noise" apart from
        # "just missed the cutoff" while tuning the multipliers above.
        outlier_near_misses = {}
        real_cluster_ids = [l for l in sorted(set(labels)) if l != -1]
        if real_cluster_ids:
            real_centroids = np.array([
                l2_normalize(X[labels == lbl]).mean(axis=0) for lbl in real_cluster_ids
            ])
            for idx in np.where(labels == -1)[0]:
                point = l2_normalize(X[idx].reshape(1, -1))
                dists = cdist(point, real_centroids, metric='cosine')[0]
                nearest_idx = int(np.argmin(dists))
                outlier_near_misses[str(idx)] = {
                    "nearestClusterId": int(real_cluster_ids[nearest_idx]),
                    "distance": float(dists[nearest_idx])
                }

        output = {
            "labels": labels.tolist(),
            "representatives": representatives,
            "outlierCounts": outlier_counts,
            "outlierNearMisses": outlier_near_misses
        }

        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()