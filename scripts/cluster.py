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
REASSIGN_TOLERANCE_MULTIPLIER = 1.5

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

def reassign_small_clusters(X, labels, threshold):
    """Clusters smaller than MIN_CLUSTER_SIZE are too small to be a meaningful category.
    Merge them into their nearest neighboring cluster if it's a near-miss (within
    tolerance of the threshold), otherwise mark them as noise (-1)."""
    labels = labels.copy()
    unique_labels, counts = np.unique(labels, return_counts=True)
    small_labels = unique_labels[counts < MIN_CLUSTER_SIZE]
    large_labels = unique_labels[counts >= MIN_CLUSTER_SIZE]

    if len(small_labels) == 0:
        return labels

    if len(large_labels) == 0:
        # Everything is small; nothing meaningful to reassign into.
        return labels

    centroids = np.array([X[labels == lbl].mean(axis=0) for lbl in large_labels])
    tolerance = threshold * REASSIGN_TOLERANCE_MULTIPLIER

    for lbl in small_labels:
        member_indices = np.where(labels == lbl)[0]
        for idx in member_indices:
            point = X[idx].reshape(1, -1)
            dists = cdist(point, centroids, metric='cosine')[0]
            nearest_idx = int(np.argmin(dists))
            if dists[nearest_idx] <= tolerance:
                labels[idx] = large_labels[nearest_idx]
            else:
                labels[idx] = -1

    return labels

def main():
    try:
        # Read the entire input from stdin
        input_data = sys.stdin.read()
        if not input_data:
            return

        # Parse the JSON embeddings
        embeddings = json.loads(input_data)

        if not embeddings or len(embeddings) == 0:
            print(json.dumps([]))
            return

        X = np.array(embeddings)

        # If there's only 1 file, return cluster 0
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
        labels = reassign_small_clusters(X, labels, threshold)

        representatives = {}
        for cluster_id in sorted(set(labels)):
            if cluster_id == -1:
                continue
            # Get indices of points in this cluster
            cluster_indices = np.where(labels == cluster_id)[0]
            if len(cluster_indices) == 0:
                continue

            # Calculate centroid
            cluster_points = X[cluster_indices]
            centroid = cluster_points.mean(axis=0)

            # Use dot product as proxy for cosine similarity (since features aren't strictly l2 normalized here)
            # Actually, compute euclidean distance to centroid for simplicity and picking reps
            distances = np.linalg.norm(cluster_points - centroid, axis=1)

            # Sort by distance to get a distribution from center to edge
            sorted_local_indices = distances.argsort()

            if len(sorted_local_indices) <= 4:
                chosen_local_indices = sorted_local_indices
            else:
                # Pick 4 diverse points across the distance distribution
                n = len(sorted_local_indices)
                chosen_local_indices = [
                    sorted_local_indices[0],             # Central core
                    sorted_local_indices[n // 3],        # Inner-middle distance
                    sorted_local_indices[(2 * n) // 3],  # Outer-middle distance
                    sorted_local_indices[-1]             # Outer edge
                ]

            chosen_global_indices = cluster_indices[chosen_local_indices].tolist()

            representatives[str(cluster_id)] = chosen_global_indices

        output = {
            "labels": labels.tolist(),
            "representatives": representatives
        }

        # Output the result as JSON
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
