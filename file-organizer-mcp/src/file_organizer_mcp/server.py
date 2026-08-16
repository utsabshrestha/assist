from __future__ import annotations

import logging
from datetime import datetime, timezone

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.middleware.cors import CORSMiddleware

from .clustering import ClusteringService, compact_evaluation
from .errors import OrganizerError
from .queue import SequentialJobQueue
from .run_store import RunStore
from .settings import Settings
from .tuning import ClusteringOverrides, Strategy
from .image_clustering import ImageDescriptionBatch, cluster_image_descriptions


settings = Settings()

logging.basicConfig(
    level=getattr(
        logging,
        settings.log_level.upper(),
        logging.INFO,
    ),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

mcp = FastMCP(
    settings.mcp_server_name,
    host=settings.mcp_host,
    port=settings.mcp_port,
    streamable_http_path=settings.mcp_path,
    json_response=True,
)

service = None

store = RunStore(
    settings.result_ttl_minutes * 60,
    settings.max_stored_runs,
)

job_queue = SequentialJobQueue(
    settings.max_queued_jobs,
    settings.queue_wait_timeout_seconds,
    settings.request_processing_timeout_seconds,
)


def error_result(exc):
    if isinstance(exc, OrganizerError):
        return {
            "status": "error",
            "error": exc.as_dict(),
        }

    logging.getLogger(__name__).exception("MCP tool failed")

    return {
        "status": "error",
        "error": {
            "code": "INTERNAL_ERROR",
            "message": str(exc),
        },
    }


@mcp.tool()
async def evaluate_clustering(
    folder_path: str,
    extensions: list[str],
    strategy: Strategy = "auto",
    overrides: ClusteringOverrides | None = None,
) -> dict:
    """
    FIRST CALL for an organization workflow. Runs and stores clustering,
    then returns compact quality metrics and a run_id without file lists.

    Use strategy='auto' first. Strategies: balanced=general purpose;
    small_collection=3-10 usable files; more_specific_topics=more/narrower groups;
    fewer_broader_topics=fewer/larger groups; strict_high_confidence=accepts more
    outliers to favor stronger groups.

    Call at most three times. If rating is good, retrieve that run. If weak:
    TOO_FEW_TOPICS or DOMINANT_TOPIC -> try more_specific_topics;
    HIGH_OUTLIER_RATIO -> try balanced or fewer_broader_topics;
    too many tiny topics -> try fewer_broader_topics. Overrides are optional and
    bounded: min_topic_size, top_terms, umap_n_neighbors,
    hdbscan_min_cluster_size, hdbscan_cluster_selection_method.

    Args:
        folder_path is the folder to analyze; extensions is one or more supported
        suffixes such as ['.pdf','.md']; strategy controls a safe server profile;
        overrides should only address a specific diagnostic.

    Returns compact dataset metrics, topic previews, score/rating/concerns,
    effective_config, adjustments, expiry, and run_id. It never moves files.
    """
    if service is None:
        return {
            "status": "error",
            "error": {
                "code": "SERVICE_NOT_READY",
                "message": "Service not initialized.",
            },
        }

    try:
        full = await job_queue.run(
            service.cluster_files,
            folder_path,
            extensions,
            strategy,
            overrides,
        )

        evaluation = compact_evaluation(full)
        run_id = store.put(full, evaluation)
        evaluation["run_id"] = run_id
        evaluation["result_ttl_minutes"] = settings.result_ttl_minutes

        return evaluation
    except Exception as exc:
        return error_result(exc)


@mcp.tool()
async def get_clustering_result(run_id: str) -> dict:
    """
    SECOND CALL after accepting an evaluate_clustering result. Retrieves the
    exact stored run; it does not rerun clustering.

    Pass the run_id from the best acceptable evaluation. Returns all topics,
    c-TF-IDF terms/scores, every assigned file with name/relative/absolute path
    and probability, outliers, skipped files, and effective configuration.
    Call only after evaluation; use its data for folder naming and file
    organization.
    """
    try:
        item = store.get(run_id)

        return {
            **item.full_result,
            "run_id": run_id,
            "evaluation": item.evaluation,
        }
    except Exception as exc:
        return error_result(exc)

@mcp.tool()
async def evaluate_image_description_clustering(images: list[dict], strategy: Strategy = "auto", overrides: ClusteringOverrides | None = None) -> dict:
    """FIRST CALL for organizing images after the host has generated text descriptions.

    This tool clusters caller-provided descriptions only. It does not open image files, generate captions, modify files, or use the embedding cache. The host must provide every image as an object containing image_id, name, absolute_path, optional relative_path, and a 20-4000 character description. image_id values must be unique.

    Start with strategy='auto'. The available strategies and bounded overrides are the same as evaluate_clustering. The response is compact and contains quality metrics, topic keyword previews, and a run_id without the full image list. If accepted, call get_clustering_result with that run_id. Make no more than three evaluations.
    """
    if service is None:
        return {"status": "error", "error": {"code": "SERVICE_NOT_READY", "message": "Service not initialized."}}
    try:
        batch = ImageDescriptionBatch(images=images, strategy=strategy, overrides=overrides)
        full = await job_queue.run(cluster_image_descriptions, service, batch)
        evaluation = compact_evaluation(full)
        run_id = store.put(full, evaluation)
        evaluation["run_id"] = run_id
        evaluation["result_ttl_minutes"] = settings.result_ttl_minutes
        return evaluation
    except Exception as exc:
        return error_result(exc)


@mcp.tool()
async def discard_clustering_result(run_id: str) -> dict:
    """
    OPTIONAL cleanup call. Deletes one rejected/unused stored clustering result
    by run_id. Embedding cache entries are preserved. Runs also expire
    automatically.
    """
    return {
        "status": "completed",
        "run_id": run_id,
        "discarded": store.discard(run_id),
    }

@mcp.prompt(
    name="file_organization_workflow",
    description=(
        "Creates instructions for safely evaluating document clustering, "
        "refining the clustering strategy when necessary, retrieving the "
        "accepted result, and preparing topic-based folder recommendations."
    ),
)
def file_organization_workflow(
    folder_path: str,
    extensions: str,
    organization_goal: str = (
        "Create practical, semantically meaningful folders without "
        "over-fragmenting the collection."
    ),
    maximum_evaluations: int = 3,
    prefer_uncategorized_over_wrong_group: bool = True,
) -> str:
    """Create the recommended file-organization agent workflow.

    Args:
        folder_path: Folder the agent should ask the MCP server to analyze.
        extensions: Comma-separated suffixes, such as ".pdf,.md,.docx".
        organization_goal: User preference for broad, balanced, or specific groups.
        maximum_evaluations: Maximum evaluate_clustering calls before selecting a run.
        prefer_uncategorized_over_wrong_group: Whether uncertain files should remain
            outliers rather than being forced into weak topics.
    """
    maximum_evaluations = max(1, min(maximum_evaluations, 3))

    confidence_guidance = (
        "Prefer strict_high_confidence when uncertain placement is more harmful "
        "than leaving some files uncategorized."
        if prefer_uncategorized_over_wrong_group
        else
        "Prefer balanced coverage, but do not force clearly unrelated files "
        "into regular topics."
    )

    return f"""
You are a file-organization agent. Your task is to analyze document
clusters, select the most practically useful clustering run, generate
concise folder names, and then allow the host application to organize
the files.

TARGET

Folder path:
{folder_path}

Extensions:
{extensions}

Organization goal:
{organization_goal}

Uncertainty preference:
{confidence_guidance}

IMPORTANT SAFETY AND SCOPE RULES

- The MCP clustering server analyzes documents only.
- The clustering tools do not move, rename, copy, or delete files.
- Do not claim that clustering tools modified the filesystem.
- Do not invent files, topics, keywords, scores, or run IDs.
- Do not use a run ID that was not returned by evaluate_clustering.
- Make no more than {maximum_evaluations} evaluate_clustering calls.
- Do not claim that a quality score proves mathematical or semantic
  optimality.
- Prefer a useful and understandable folder structure over marginal
  improvements to a numeric score.
- Do not repeatedly tune a result that is already rated good and has
  no serious concerns.

AVAILABLE TOOLS

1. evaluate_clustering

This must be the first clustering tool called.

Required arguments:

- folder_path: the folder to analyze.
- extensions: an array of supported suffixes, such as
  [".pdf", ".md", ".docx"].

Optional arguments:

- strategy: one of:
  - auto
  - balanced
  - small_collection
  - more_specific_topics
  - fewer_broader_topics
  - strict_high_confidence
- overrides: bounded advanced settings. Use these only to respond to a
  specific diagnostic:
  - min_topic_size
  - top_terms
  - umap_n_neighbors
  - hdbscan_min_cluster_size
  - hdbscan_cluster_selection_method

Always begin with strategy="auto" unless the user has explicitly asked
for broad, narrow, or strict groupings.

evaluate_clustering runs and temporarily stores a complete clustering
result. It returns a compact evaluation containing:

- run_id
- rating and quality score
- concern codes
- topic count
- topic sizes
- outlier ratio
- largest-topic ratio
- mean topic cohesion
- mean cluster probability
- compact topic keyword previews
- effective configuration
- server-applied parameter adjustments
- result expiration information

It intentionally does not return every filename.

2. get_clustering_result

Call this only after selecting an evaluated run.

Required argument:

- run_id: the exact run ID returned by evaluate_clustering.

This retrieves the exact stored result and does not rerun clustering.

It returns:

- complete topic assignments
- all files in each topic
- filenames
- relative and absolute paths
- extensions
- cluster probabilities
- c-TF-IDF terms and scores
- outliers
- skipped files
- effective clustering configuration

3. discard_clustering_result

This tool is optional.

Required argument:

- run_id: a rejected or unused evaluated run.

It removes a stored result but preserves embedding-cache entries.
Stored runs also expire automatically.

MANDATORY WORKFLOW

Step 1: Evaluate defaults

Call evaluate_clustering with:

- folder_path="{folder_path}"
- extensions derived from "{extensions}"
- strategy="auto"

Step 2: Interpret the result

Inspect all of the following:

- evaluation.rating
- evaluation.score
- evaluation.concerns
- clustering.topic_count
- clustering.outlier_ratio
- clustering.largest_topic_ratio
- clustering.mean_topic_cohesion
- clustering.mean_cluster_probability
- topic_previews
- effective_config
- adjustments

Do not judge the result from the score alone.

Step 3: Accept or refine

Accept the first run when:

- rating is good,
- no concern indicates a practically unusable structure,
- topic previews are semantically distinct and nameable,
- topic sizes are reasonable for the collection,
- the result satisfies the user's organization goal.

If refinement is necessary, make one targeted change.

Use these rules:

- TOO_FEW_TOPICS:
  Try more_specific_topics.

- DOMINANT_TOPIC:
  Try more_specific_topics.

- HIGH_OUTLIER_RATIO:
  Try balanced or fewer_broader_topics.
  If incorrect placement is worse than leaving files uncategorized,
  a higher outlier ratio may still be acceptable.

- LOW_COHESION:
  Try more_specific_topics or strict_high_confidence.

- Too many tiny or fragmented topics:
  Try fewer_broader_topics.

- Only 3 through 10 usable documents:
  Consider small_collection.

- Strong unrelated outliers are preferable to semantically incorrect
  assignments:
  Consider strict_high_confidence.

Change only the strategy first. Use numeric overrides only when the
diagnostic gives a clear reason.

Step 4: Compare candidate runs

If more than one evaluation was performed:

- compare all candidate runs,
- consider practical topic meaning in addition to numeric metrics,
- select the most useful run,
- do not automatically select the latest run,
- do not automatically select the highest score when its topics are
  less understandable.

Step 5: Retrieve the accepted result

Call get_clustering_result exactly once with the selected run_id.

Step 6: Generate folder recommendations

For every regular topic:

- inspect c-TF-IDF terms and scores,
- give greater weight to higher-scoring terms,
- identify the shared semantic concept,
- generate one concise and descriptive folder name,
- avoid generic names such as "Documents", "Files", "Miscellaneous",
  or a raw list of keywords,
- avoid including the internal topic ID unless needed for collision
  handling,
- do not combine unrelated concepts merely to include every keyword.

Folder names should normally contain two through five meaningful words.

Step 7: Handle outliers and skipped files

- Treat outliers separately from regular topics.
- Do not force outliers into a topic without supporting evidence.
- Recommend an Uncategorized or Review Needed area only when useful.
- Report skipped files and their reasons.
- Do not infer document content for files that could not be extracted.

Step 8: Produce the final plan

Return a structured organization plan containing:

- selected run ID
- selected strategy and effective configuration
- brief explanation of why the run was selected
- one proposed folder name for each topic
- the files assigned to each proposed folder
- outliers requiring review
- skipped files
- warnings that need user attention

The host application, not the MCP clustering tools, is responsible for
performing filesystem changes.
""".strip()

def create_app():
    app = mcp.streamable_http_app()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:8080",
            "http://localhost:8080",
        ],
        allow_credentials=False,
        allow_methods=[
            "GET",
            "POST",
            "DELETE",
            "OPTIONS",
        ],
        allow_headers=[
            "Accept",
            "Content-Type",
            "Last-Event-ID",
            "MCP-Protocol-Version",
            "MCP-Session-Id",
        ],
        expose_headers=["MCP-Session-Id"],
        max_age=600,
    )

    return app


def main():
    global service

    service = ClusteringService(settings)

    logging.getLogger(__name__).info(
        "MCP endpoint: http://%s:%s%s",
        settings.mcp_host,
        settings.mcp_port,
        settings.mcp_path,
    )

    uvicorn.run(
        create_app(),
        host=settings.mcp_host,
        port=settings.mcp_port,
        log_level=settings.log_level.lower(),
        workers=1,
    )


if __name__ == "__main__":
    main()