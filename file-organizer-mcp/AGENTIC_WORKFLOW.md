# Agentic clustering workflow

The MCP server exposes three tools:

1. `evaluate_clustering` — always call first, normally with `strategy: "auto"`.
2. `get_clustering_result` — call with the accepted `run_id`; retrieves the exact stored result without reclustering.
3. `discard_clustering_result` — optional cleanup for rejected runs.

Recommended agent policy:

- Make at most three evaluations.
- Accept `rating: good` unless a concern conflicts with the user's intent.
- `TOO_FEW_TOPICS` or `DOMINANT_TOPIC`: try `more_specific_topics`.
- `HIGH_OUTLIER_RATIO`: try `balanced` or `fewer_broader_topics`.
- Too many tiny topics: try `fewer_broader_topics`.
- Compare completed candidates and retrieve the best `run_id`, not necessarily the last one.
- Do not claim the score is ground truth or globally optimal.

Example first call:

```json
{"folder_path":"/Users/name/Documents","extensions":[".pdf",".md"],"strategy":"auto"}
```

Example refinement:

```json
{"folder_path":"/Users/name/Documents","extensions":[".pdf",".md"],"strategy":"more_specific_topics","overrides":{"top_terms":8}}
```

Example accepted-result retrieval:

```json
{"run_id":"run_abc123"}
```
