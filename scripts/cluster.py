import sys
import json
import numpy as np
from sklearn.cluster import AgglomerativeClustering

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
        
        # HDBSCAN is often too strict with sparse filename embeddings. 
        # AgglomerativeClustering allows us to group by a straight cosine distance threshold.
        # Cosine distance = 1 - cosine similarity. 
        # A threshold of 0.40 is a middle ground between too many (0.35) and too few (0.50) clusters.
        clusterer = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=0.35, # Adjusted to 0.40 to balance cluster sizes
            metric='cosine',
            linkage='average'
        )
        
        labels = clusterer.fit_predict(X)
        
        n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
        
        representatives = {}
        for cluster_id in range(n_clusters):
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
