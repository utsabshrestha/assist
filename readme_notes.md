# File Organization Agent — Detailed Notes for README

> **Note on evolution:** An earlier version of the image pipeline ran embeddings in-process via
> `nomic-embed-text-v1.5.Q6_K.gguf` loaded with `node-llama-cpp` (`EmbeddingService.ts`), then
> spawned a Python child process (`scripts/clusterV3.py`) for HDBSCAN clustering — bridged through
> `ClassificationUtility.clusterEmbeddings()` (now `@deprecated`). Both the in-process embedder and
> the Python bridge were replaced by the dedicated `file-organizer-mcp` Python MCP server, which owns
> the full embedding → BERTopic → evaluation pipeline. The `imageClassificationTool.ts` still
> contains the old code paths for historical reference.

---

## Project Overview

This is a **desktop file organization application** built as an Electron app (Node.js + TypeScript + React). It uses a
locally-running small language model — **`unsloth/Ministral-3-8B-Reasoning-2512-GGUF`** — served via llama.cpp's HTTP
server (OpenAI-compatible API). The core design thesis is:

> **You don't need a massive frontier model to build a complex agentic workflow — with careful orchestration, task decomposition, and curated prompting, a small 3-8B language model can handle sophisticated multi-step agentic pipelines.**

The project lives in a monorepo with two distinct applications:

1. **Main App** — Electron + Node.js + TypeScript + React (`/src`, `/tools`, `/electron`, `/renderer`)
2. **MCP Server** — Python FastMCP server implementing BERTopic-based file clustering (`/file-organizer-mcp`)

---

## The Core Philosophy — Divide and Conquer with Small Models

Small language models cannot hold a large, complex task in context and reason about it reliably all at once. This project
solves that through **orchestrated agent specialization**:

- **Each agent has one narrow job** with a minimal, focused toolset.
- **Shared state (not message passing)** is the backbone — agents read/write to a central `fileAgentState` object
  identified by a UUID `processId`. No agent needs to "remember" what another did.
- **Sentinel-based handoff** — agents signal stage transitions by returning magic string constants
  (`__HANDOFF_CATEGORIZATION__`, `__HANDOFF_EXECUTION__`, `__ERROR_ENCOUNTERED__`), not by reasoning about what to do next.
- **forceToolUse** — the `OpenAISession` loop forces the model to make a tool call if it tries to respond with plain text,
  with up to 3 retries before logging a stall.
- **Auto-continue loop** with a max of 5 auto-continues per stage prevents infinite loops while giving the model room to
  multi-step through its toolset.

---

## Application Architecture — Node.js + Electron

### Entry Point: `FileAgent.chatLoop()` — `src/agent.ts`

This is the top-level orchestrator. It does **not** use any LLM calls itself — it simply sequences three agent stages in
order:

```
User Message → [Stage 1: Planner] → [Stage 2: Categorizer] → [Stage 3: Executor]
```

Each stage:
1. Instantiates a fresh `OpenAISession` with a new system prompt scoped to that stage.
2. Seeds the session with an initial user message.
3. Runs a `while(true)` loop, calling `session.prompt("Continue with the next step.")` until a sentinel is returned or
   an error/stall is detected.
4. Checks the sentinel to decide whether to proceed or abort.

Between Stage 2 and Stage 3, the code validates that at least one file has a confirmed plan and no tasks have failed,
before proceeding to execution.

---

### The Execution Engine: `OpenAISession` — `src/workerAgent.ts`

`OpenAISession` is the heart of the system. It is a **stateful chat session** that:

- Maintains a growing `messages[]` array (system + user + assistant + tool messages).
- Converts the tool registry (`Record<string, {description, params, handler}>`) into OpenAI function definitions at
  prompt time.
- Calls `llm.openai.chat.completions.create()` in a loop until:
  - No tool calls are made (agent is done).
  - A sentinel string is returned from a tool handler.
  - An error sentinel is returned.
- **forceToolUse retry logic**: if the model replies with text instead of a tool call (and `forceToolUse: true`), the
  session injects a corrective message and retries up to 3 times.
- **Emits real-time updates** via `emitLog()` and `emitAgentMessage()` to the Electron renderer process for live UI
  feedback.

Tool results are returned as strings and injected back into the conversation as `{role: "tool", ...}` messages. Sentinel
strings short-circuit the entire loop and propagate back to `FileAgent.chatLoop()`.

---

### LLM Backend: `LLMService` — `src/LLMService.ts`

A singleton service that wraps an OpenAI SDK client pointed at a **local llama.cpp HTTP server** (default port 8080).
The model name is `"local-model"` — llama-server ignores this and uses whatever `.gguf` model is loaded. The key
insight: the OpenAI-compatible API means no LLM-provider-specific SDK is needed.

```
OpenAI SDK → http://localhost:8080 → llama-server (Ministral-3-8B-Reasoning-2512-GGUF)
```

`temperature: 0.6` is used across all completions.

---

## The Three-Stage Pipeline

### Stage 1 — Planning Agent (`planningAgentSystemPrompt`)

**Goal:** Understand the workspace, let the user select what to organize, build a task list, then hand off.

**Tools available:**

| Tool | Purpose |
|------|---------|
| `GetFolderSummaryTool` | Scans the directory; categorizes files into `documents`, `images`, `non-documents`; populates `fileAgentState` |
| `PresentScopeSelectionTool` | Emits a UI checklist to the renderer for user scope selection; waits for user response via IPC |
| `CreateTodoListTool` | Writes the `todoList` to `fileAgentState` |
| `ViewTodoListTool` | Reads the todo list back (for verification) |
| `UpdateTodoListTool` | Modifies task statuses |
| `MemoryScratchpadTool` | A lightweight scratchpad for the agent to persist notes across turns |
| `HandOffToCategorizationAgent` | Validates todo list is non-empty, sets `state.phase = 'categorization'`, returns sentinel |
| `ErrorEncountered` | Logs error, returns error sentinel to abort pipeline |

**Strict rules baked into the prompt:**
- Never respond with plain text — every turn MUST be a tool call.
- Never build the task list from memory — use only what `PresentScopeSelectionTool` returns.
- Never call worker agents or execution agents.
- Never ask the user about naming conventions, preferences, etc.

**Key design decision:** `GetFolderSummaryTool` filters out temporary/lock files (`.DS_Store`, `~$*`, `.swp`, etc.)
and does NOT assign images to a category upfront — image categorization happens with vision analysis later.

---

### Stage 2 — Categorization Agent (`categorizationAgentSystemPrompt`)

**Goal:** Read the todo list and dispatch the correct worker sub-agent for each task. Update task statuses. Hand off
to execution.

**Tools available:**

| Tool | Purpose |
|------|---------|
| `ViewTodoListTool` | Read the task list |
| `UpdateTodoListTool` | Mark tasks in-progress / completed / failed |
| `MemoryScratchpadTool` | Access any notes recorded during planning |
| `DocumentCategorizationAgent` | Spins up a document worker agent for one task |
| `NonDocumentCategorizationAgent` | Spins up a non-document worker agent for one task |
| `ImageCategorizationAgent` | Spins up an image worker agent for one task |
| `HandOffToExecutionAgent` | Validates all tasks done, sets `state.phase = 'execution'`, returns sentinel |
| `ErrorEncountered` | Aborts pipeline |

This is a **task orchestrator** — it loops through the todo list in order, dispatches the right sub-agent based on task
title (documents/non-documents/images), and tracks per-task status.

**Each categorization sub-agent** (Document, NonDocument, Image) is itself a full `OpenAISession` that:
1. Optionally invokes the MCP BERTopic server for semantic clustering.
2. Presents a proposed folder plan to the user for approval.
3. Handles rename/merge requests from the user (interactive loop).
4. Finalizes the folder plan in `fileAgentState.proposedFolderPlan`.

---

### Stage 3 — Execution Agent (`executionAgentSystemPrompt`)

**Goal:** Show the final movement plan, confirm with the user, then physically move files.

**Tools available:**

| Tool | Purpose |
|------|---------|
| `getFinalPlanConfirmation` | Presents the complete proposed file movement plan to the user via the UI |
| `Executetheprocess` | Creates folders and moves files according to the finalized plan |
| `ExecutionDeclined` | Clean abort if the user declines |
| `ErrorEncountered` | Error abort |

This is intentionally the **simplest agent** — it has exactly one decision to make (proceed or abort) and one action
(execute). This keeps the final critical step as deterministic as possible.

---

## Worker Sub-Agents — The Deep Pipeline

Each categorization worker (document, image, non-document) is itself an orchestrated agent that follows a
**cluster → evaluate → approve → finalize** workflow. This is where the MCP server enters the picture.

### Document Worker (`documentWorkerAgentSystemPrompt`)

The document worker agent operates as an LLM agent with this exact tool set:

```typescript
const docTools = {
    McpClusteringAgent,                            // spawns MCP clustering sub-agent
    PresentDocumentFolderPlanTool,                 // shows plan to user, waits for approval
    UpdateCategoryNameTool,                        // renames/merges categories on user request
    FinalizeThefolderforthefilesforEachExtensions, // writes confirmed plan to state
    ErrorEncountered
};
```

For each document extension (e.g., `.pdf`, `.docx`):

1. **`McpClusteringAgent`** — spawns a dedicated MCP clustering sub-agent (`mcpClusteringAgentSystemPrompt`).
   This sub-agent itself has its own tool set (`mcpClusteringAgentTools.ts`):
   - `evaluate_clustering` (direct MCP tool call) — runs BERTopic, returns compact metrics + `run_id`.
   - `discard_clustering_result` (direct MCP tool call) — cleans up rejected runs.
   - `FetchAndProcessClusteringResultTool` — retrieves the accepted run's full result and internally
     runs **per-topic LLM naming** (the Topic Name Suggestion Agent, see below).
   - `ReportClusteringCompleteTool` — signals the parent agent that the folder plan is ready.
   - `ErrorEncountered` — aborts on failure.
   
   The sub-agent evaluates quality metrics (rating, score, topic previews, outlier ratio, cohesion) and
   can retry up to 3 times with different strategies (`auto`, `more_specific_topics`,
   `fewer_broader_topics`, `small_collection`, `strict_high_confidence`).

2. **`PresentDocumentFolderPlanTool`** — shows the generated folder plan to the user.
3. **Interactive approval loop**: user can rename or merge categories; agent calls `UpdateCategoryNameTool`
   and re-presents. Loops until `USER_APPROVED`.
4. **`FinalizeThefolderforthefilesforEachExtensions`** — writes the confirmed plan to `fileAgentState`.

### Image Worker (`imageWorkerAgentSystemPrompt`)

The image worker agent operates as an LLM agent with this exact tool set:

```typescript
const imageTools = {
    McpImageClusteringAgent,              // spawns MCP image clustering sub-agent
    PresentImageFolderPlanTool,           // shows plan to user, waits for approval
    UpdateCategoryNameForImagesTool,      // renames/merges categories on user request
    FinalizeThefolderforImages,           // writes confirmed plan to state
    ErrorEncountered
};
```

For images (`.jpg`, `.png`, `.webp`, `.gif`, `.svg`, etc.) — the workflow is **vision-first**:

1. **`McpImageClusteringAgent`** — spawns a dedicated MCP image clustering sub-agent
   (`mcpImageClusteringAgentSystemPrompt`). This sub-agent has its own tool set (`mcpImageClusteringAgentTools.ts`):
   - `GetImageDescriptionsTool` — calls the LLM vision API for every unprocessed image, generating
     a 20–4,000 character natural-language description per image. Descriptions are stored in-process
     state — NOT returned to the sub-agent (token economy). Returns only `{status, imageCount}`.
   - `EvaluateImageDescriptionClusteringTool` — sends stored descriptions to the MCP server's
     `evaluate_image_description_clustering` tool. Same quality-metrics + strategy retry logic as
     document clustering (up to 3 evaluations).
   - `discard_clustering_result` — cleans up rejected runs.
   - `FetchAndStoreImageClusteringResultTool` — retrieves the full result and stores it in-process.
   - `ProcessImageClusteringResultTool` — names each topic via LLM (using c-TF-IDF keywords +
     sampled image descriptions), deduplicates categories, writes folder plan to state.
   - `ReportImageClusteringCompleteTool` — signals the parent agent.
   - `ErrorEncountered` — aborts on failure.

2. **`PresentImageFolderPlanTool`** — shows the generated folder plan to the user.
3. **Interactive approval loop**: user can rename or merge; agent calls `UpdateCategoryNameForImagesTool`
   and re-presents. Loops until `USER_APPROVED`.
4. **`FinalizeThefolderforImages`** — writes the confirmed plan to `fileAgentState`.

### Non-Document Worker (`nonDocumentWorkerAgentSystemPrompt`)

The non-document worker agent operates as an LLM agent with this exact tool set:

```typescript
const nonDocTools = {
    GetCategoriesForNonDocuments,             // LLM extension categorization
    PresentNonDocumentFolderPlanTool,         // shows plan to user, waits for approval
    UpdateCategoryNameForNonDocumentsTool,    // renames/merges categories on user request
    FinalizeThefolderforNonDocuments,         // writes confirmed plan to state
    ErrorEncountered
};
```

For binary/other files (videos, archives, executables, audio, etc.):

1. **`GetCategoriesForNonDocuments`** — calls `FileClassificationTool.GetNonDocumentExtensionCategorized()`.
   This does a **two-tier categorization**:
   - **Deterministic lookup first** — a pre-built extension→category map (`extensionCategoryMap.ts`)
     handles common extensions without any LLM call.
   - **LLM fallback for unknown extensions** — calls the LLM once with `nonDocumentCategorizationPrompt`
     and a strict JSON schema (`response_format: json_schema`) at `temperature: 0.1` to categorize
     only the unrecognized extensions into semantic groups: Video, Audio, Archives, Code_Scripts,
     Apps_Packages, Data_Markup, Misc.
2. Present → interactive approval → finalize.

---

## The MCP Server — `file-organizer-mcp` (Python)

A **FastMCP** server (Streamable HTTP) built with Python, exposing three MCP tools:

| Tool | Description |
|------|-------------|
| `evaluate_clustering` | Runs BERTopic on documents in a folder; returns compact quality metrics + `run_id`. Never returns file lists (token safety). |
| `get_clustering_result` | Retrieves the full stored result for a given `run_id` (file assignments, c-TF-IDF terms, probabilities). |
| `evaluate_image_description_clustering` | Clusters caller-provided text descriptions of images (no file access needed). |
| `discard_clustering_result` | Cleans up a rejected/unused clustering result from memory. |

---

## Single-Scope LLM Agents Inside Tool Handlers

A critical design insight is that many tool handlers themselves contain **focused, single-purpose LLM calls** —
not agentic loops, but direct `chat.completions.create()` calls for a very specific subtask. These are
implemented in `tools/fileClassificationTool.ts`, `tools/imageClassificationTool.ts`, and
`src/utils/classificationUtility.ts`.

### Topic Name Suggestion Agent (`fileClassificationTool.ts` → `nameTopicsFromMcpResponse`)

Called inside `FetchAndProcessClusteringResultTool` after BERTopic runs. For each topic cluster returned
by the MCP server:

- Receives **c-TF-IDF keywords** (ranked, most distinctive first) and up to 4 **representative file names**
  tagged by their position from cluster core to edge (`[Core]`, `[Mid-1]`, `[Edge]`).
- Calls the LLM once per topic with `fileCategorizationPrompt` (the folder naming system prompt) at
  `temperature: 0.2`, `max_tokens: 1800`, `repeat_penalty: 1.1`.
- The model reasons freely in `<think>` or free text, then emits its answer inside `<output>...</output>` tags.
- **`extractTaggedOutput()`** parses the response — extracts the content between `<output>` tags,
  stripping any `<think>` scaffolding. Handles both `content` and `reasoning_content` fields (for
  different reasoning model variants).
- If no `<output>` tag is found (common small-model failure), the handler calls `repairTaggedOutput()`.

**Why `<output>` tags instead of JSON schema?**  
For this task the model needs to reason first (looking at keywords, identifying the semantic domain,
checking for mixed clusters) and only then commit to a name. Forcing `json_schema` makes it emit a
compliance token immediately, with no room to think, producing worse names. Free-form + `<output>` tag
gives it the full reasoning trace first.

### Topic Name Repair Agent (`classificationUtility.ts` → `repairTaggedOutput`)

A dedicated last-resort LLM call when the Topic Name Suggestion Agent fails to close its `<output>` tag:

- Feeds the raw incomplete output back with a terse instruction: _"Extract the folder name it was converging
  on, in Title_Case_With_Underscores, 1-4 words. Respond with `<output>Name</output>` only."_
- Runs at `temperature: 0`, `max_tokens: 60` (tight budget — extraction not reasoning), `repeat_penalty: 1.1`.
- Returns `null` if repair also fails; callers fall back to `Category_N`.
- Logged to the `'Topic Repairing Agent'` channel in the UI side panel.

### Topic Name Deduplication Agent (`classificationUtility.ts` → `deduplicateCategories`)

After all topics are named, similar category names are merged using a **chunked multi-pass LLM deduplication**:

- **Chunking** (chunk size = 9): small models lose accuracy reasoning over long lists in one shot, so the full
  list is split into chunks of 9 names each.
- **Per-chunk LLM call** (`requestMergesForChunk`): each chunk is sent to the LLM with `dedupCategoryPrompt`
  (a taxonomy engine prompt). The model outputs a JSON `{merges: [{source, target}]}` object.
  - `temperature: 0.2`, `max_tokens: 800`, `repeat_penalty: 1.3`.
- **Multi-pass**: runs up to 2 passes. After applying pass-1 merges, if the list shrank and still spans
  multiple chunks, a second pass catches cross-chunk duplicates.
- **Stops early** if no merges are produced or the list fits in a single chunk.
- Merges are then applied to the `result` Record, concatenating files from the source category into the
  target and deleting the source.
- Logged to the `'Topic Name Deduplication Agent'` channel.

This runs for **both document topics** (in `FileClassificationTool.nameTopicsFromMcpResponse`) and
**image clusters** (in `ImageClassificationTool.clusterAndNameImages`).

### Image Description Agent (`imageClassificationTool.ts` → `clusterAndNameImages` Step 1)

> **Note:** This code path in `imageClassificationTool.ts` uses the **old** in-process embedding architecture
> and is superseded by the MCP image pipeline. It is preserved for reference. The active production path
> goes through `GetImageDescriptionsTool` inside the MCP image clustering sub-agent.

The old image pipeline ran vision LLM calls directly in the Node.js tool handler:

1. **Image resize** — each image is resized to max 256px using `sharp` (`getLowResBase64Image`) before the
   LLM call to minimize VRAM usage.
2. **Vision LLM call per image** (sequential, to avoid RAM overload):
   - `imageDescriptionPrompt` as system prompt.
   - Image sent as `image_url` with `data:image/jpeg;base64,...` encoding.
   - `temperature: 0.1`, `response_format: json_schema` enforcing `{description: string}`.
   - Falls back to filename if description fails.
3. **Embed descriptions** — using the in-process `EmbeddingService` (nomic-embed-text-v1.5 via node-llama-cpp).
4. **Cluster via Python bridge** — `ClassificationUtility.clusterEmbeddings()` spawned a Python child process
   (`scripts/clusterV3.py`) over stdin/stdout with HDBSCAN. **This is now `@deprecated`.**
5. **Name clusters** — same `fileCategorizationPrompt` + `<output>` tag pattern as documents.
6. **Deduplicate** — same `deduplicateCategories` pass.

The `representatives` field from the Python bridge contained cluster members sampled from core to edge
(via `np.linspace` on distance-to-centroid), tagged with position labels (`Core`, `Mid-1`, `Edge`) to
give the LLM spatial context about cluster density.

### `GetNonDocumentExtensionCategorized` — Two-Tier LLM Call

The tool handler for non-document categorization uses a deliberate two-tier approach:

1. **Deterministic lookup** (`extensionCategoryMap.ts`) — a static map handles common extensions (`.mp4` → Video,
   `.zip` → Archives, etc.) with zero LLM cost.
2. **LLM call for unknowns only** — only extensions not in the static map are sent to the model.
   Uses `response_format: json_schema` (unlike the topic naming agent) because this IS a structured
   classification with a known output shape — no free-form reasoning needed.
   `temperature: 0.1` for maximum determinism.

### BERTopic Pipeline (`clustering.py`)

The `ClusteringService` class:

1. **File Discovery** — finds files by extension, validates path safety.
2. **Text Extraction** — per-extension extractors (PDF, DOCX, PPTX, XLSX, EPUB, HTML, etc.) pull text content.
3. **Embedding** — uses `nomic-embed-text-v1.5.Q6_K.gguf` (a GGUF-quantized embedding model) loaded via
   `llama-cpp-python`. Embeddings are **cached** per file (hash-based) so repeated runs are fast.
4. **BERTopic Clustering** — uses UMAP for dimensionality reduction and HDBSCAN for density-based clustering.
   `ClassTfidfTransformer` (c-TF-IDF) extracts per-topic keywords.
5. **Strategy Tuning** (`tuning.py`) — maps strategy names to safe parameter configs for UMAP/HDBSCAN. The LLM agent
   can select a strategy; the server applies bounded overrides.
6. **Quality Evaluation** — scores each run on topic count, outlier ratio, cohesion, topic dominance, and cluster
   probability. Returns structured concern codes (e.g., `TOO_FEW_TOPICS`, `HIGH_OUTLIER_RATIO`).
7. **Run Store** (`run_store.py`) — temporarily stores full results in memory with a configurable TTL. Results are
   retrieved by `run_id`, not re-computed.
8. **Sequential Job Queue** (`queue.py`) — prevents concurrent BERTopic runs (HDBSCAN is not thread-safe).

### Image Clustering (`image_clustering.py`)

Images are clustered by their **LLM-generated text descriptions** (not pixel data). The process:
1. The Node.js agent generates descriptions using the vision-capable LLM.
2. Descriptions are sent to `evaluate_image_description_clustering`.
3. BERTopic clusters the descriptions exactly like document text.

### Architecture Design Choices

- **No file movement happens in the MCP server** — it only analyzes and classifies. File system operations are done
  by the Node.js execution agent.
- **Embedding cache** — prevents re-embedding unchanged files across multiple organization runs.
- **CORS** — configured to allow only `localhost:8080` (the llama.cpp server port), not arbitrary origins.
- **Single worker** — `uvicorn` runs with `workers=1` to serialize all BERTopic jobs safely.

---

## Shared State: `fileAgentState` — `src/state/fileAgentState.ts`

All agents share a single `fileAgentState` instance, keyed by `processId` in the global `fileAgentRecord` dictionary.
This is the **single source of truth** for the entire pipeline.

Key fields:

| Field | Purpose |
|-------|---------|
| `workspacePath` | Root folder being organized |
| `fileListData` | All discovered `fileStatus` objects |
| `fileByExtension` | Files grouped by extension |
| `categorySummary` | `{documents, images, non-documents}` extension lists |
| `todoList` | `TodoItem[]` — the plan the Planner creates |
| `globalNotes` | Scratchpad notes from any agent |
| `proposedFolderPlan` | Keyed by extension (docs) or `__task_${TaskId}` (images/non-docs) |
| `mcpClusterResults` | Raw MCP results stored between two-step tool calls |
| `phase` | `'planning' / 'categorization' / 'execution' / 'done'` |
| `planConfirmed` | Whether the user has confirmed the final execution plan |

This shared state design means:
- Agents don't need to pass data through tool arguments (prevents context bloat).
- The LLM never reconstructs its own understanding of what was done — it reads ground truth from state.
- Token economy is preserved at every step.

---

## IPC Bridge — Electron Real-Time UI Updates

The Electron main process emits events to the renderer (React UI) via `ipcBridge.ts`:

| Event | Purpose |
|-------|---------|
| `emitLog(msg, type, label)` | Sends agent activity logs (tool calls, results, errors) to the side panel |
| `emitAgentMessage(msg, role)` | Sends chat-style messages (agent status updates) to the main panel |
| `emitStage(stage)` | Updates the pipeline stage indicator in the UI |
| `emitTodoUpdate(todoList)` | Sends the current todo list to the UI for display |
| `requestScopeSelection(...)` | Sends the scope checklist to the renderer and waits for user input via a Promise |

The `requestScopeSelection` call is particularly interesting — it's a Promise that only resolves when the user clicks a
button in the UI, creating a natural pause in the agentic pipeline for user interaction without blocking the main thread.

---

## Tool Design Patterns

All tools follow a consistent schema:

```typescript
const SomeTool = {
    description: "...",      // Fed to the LLM as the function description
    params: {                // JSON Schema for arguments
        type: "object",
        properties: { ... },
        required: [...]
    },
    async handler(params): Promise<string> {
        // Always returns a string (tool result)
        // Special prefixes:
        // "__HANDOFF_CATEGORIZATION__" → triggers stage transition
        // "__HANDOFF_EXECUTION__"       → triggers stage transition
        // "__ERROR_ENCOUNTERED__"       → triggers pipeline abort
        // "__Execution_Decline__"       → clean user decline
    }
}
```

Tools grouped into sets per agent role (`PlanningTools`, `CategorizationTools`, `ExecutionTools`) and passed as
`functions` to `OpenAISession.prompt()`. The session handles OpenAI function calling format conversion automatically.

---

## Technology Stack Summary

### Main Application

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 37 |
| UI framework | React 19 + Vite |
| Language | TypeScript 6 |
| LLM inference | llama.cpp HTTP server (OpenAI-compatible) |
| LLM SDK | `openai` npm package (v6) + `@openai/agents` |
| Document parsing | `pdf-parse`, `mammoth`, `officeparser`, `epub2`, `xlsx` |
| Image processing | `sharp` |
| MCP client | `@modelcontextprotocol/sdk` |

### MCP Server

| Layer | Technology |
|-------|-----------|
| Server framework | FastMCP (Streamable HTTP via uvicorn) |
| Language | Python 3.11+ |
| Topic modeling | BERTopic 0.17 |
| Dimensionality reduction | UMAP |
| Clustering | HDBSCAN |
| Embeddings | nomic-embed-text-v1.5 (GGUF via llama-cpp-python) |
| Document parsing | pypdf, python-docx, python-pptx, openpyxl, EbookLib, BeautifulSoup4 |
| Validation | Pydantic v2 |

### The Model

- **LLM**: `unsloth/Ministral-3-8B-Reasoning-2512-GGUF` (Mistral 3B, quantized)
- **Served via**: llama.cpp HTTP server (OpenAI-compatible API at `http://localhost:8080`)
- **Embedding model**: `nomic-embed-text-v1.5.Q6_K.gguf` (used inside the Python MCP server)

---

## File Organization Flow — End to End

```
User types a folder path
        |
[Planning Agent]
  GetFolderSummaryTool         -- scans folder, populates fileAgentState
  PresentScopeSelectionTool    -- shows UI checklist, waits for user
  CreateTodoListTool           -- writes todo list to state
  HandOffToCategorizationAgent -- returns __HANDOFF_CATEGORIZATION__
        |
[Categorization Agent]
  ViewTodoListTool             -- reads todo list
  For each task:
    UpdateTodoListTool         -- status: 'in-progress'
    DocumentCategorizationAgent / NonDocumentCategorizationAgent / ImageCategorizationAgent
      |
      [Document Sub-Agent]
        McpClusteringAgent
          -- calls evaluate_clustering (MCP) up to 3x
          -- selects best run, calls FetchAndProcessClusteringResultTool
          -- LLM names topics from c-TF-IDF keywords
        PresentDocumentFolderPlanTool -- shows plan, waits for user
        (user can rename/merge categories)
        FinalizeThefolderforthefilesforEachExtensions -- writes to proposedFolderPlan
      [Image Sub-Agent]
        GetImageDescriptionsTool      -- LLM vision describes each image
        EvaluateImageDescriptionClusteringTool -- clusters descriptions via MCP
        FetchAndStoreImageClusteringResultTool
        ProcessImageClusteringResultTool -- names topics, deduplicates
        PresentImageFolderPlanTool    -- shows plan, waits for user
        FinalizeThefolderforImages    -- writes to proposedFolderPlan
      [Non-Document Sub-Agent]
        GetCategoriesForNonDocuments  -- LLM categorizes extensions by type
        PresentNonDocumentFolderPlanTool -- shows plan, waits for user
        FinalizeThefolderforNonDocuments -- writes to proposedFolderPlan
    UpdateTodoListTool -- status: 'completed'/'failed'
  HandOffToExecutionAgent -- returns __HANDOFF_EXECUTION__
        |
[Execution Agent]
  getFinalPlanConfirmation     -- shows complete movement plan, waits for user
  Executetheprocess            -- creates folders, moves files
        |
  Done
```

---

## Key Innovations and Design Insights

### 1. Sentinel-Based Stage Handoff
Instead of the LLM reasoning about what to do next across stages, each stage ends with a deterministic sentinel string
returned from a tool. The `OpenAISession` loop detects this and propagates it back to `FileAgent.chatLoop()`. This
eliminates cross-stage hallucination entirely.

### 2. State-as-Memory (Not Context-as-Memory)
All critical data lives in `fileAgentState`, not in the LLM's context window. Agents read what they need from state
(via tool calls) and write back to state (via tool handlers). The LLM's context contains only the current conversation
turn, not the entire history of the organization process.

### 3. Two-Step MCP Result Processing
BERTopic results can be large (full file lists with embeddings). The MCP workflow splits this into two tool calls:
- `evaluate_clustering` returns only compact quality metrics (safe for context).
- `get_clustering_result` returns full data, but is called **inside** a tool handler (never passed to the LLM).

The LLM never sees raw file lists or embedding vectors. It only sees compact summaries.

### 4. Interactive Approval Loops Within Sub-Agents
Each categorization sub-agent has a built-in approval loop — it presents a plan, waits for user input, handles
rename/merge requests, and only calls Finalize after receiving explicit `USER_APPROVED`. This keeps humans in the loop
without requiring a separate agent stage.

### 5. forceToolUse with Corrective Re-Prompting
When the model outputs plain text instead of a tool call (a common failure mode for small models), the session
auto-injects a corrective message: "You must respond ONLY by calling one of these tools: [list]. Do not reply with
plain text." This recovers from a large category of small-model failures automatically.

### 6. Strategy-Guided Clustering
The BERTopic clustering is not fixed — the MCP sub-agent evaluates results and can retry with different strategies
(`more_specific_topics`, `fewer_broader_topics`, `small_collection`, `strict_high_confidence`). The strategy selection
is guided by structured concern codes, not ad-hoc reasoning.

---

## Repository Structure

```
assist/                                  (Monorepo root)
├── src/
│   ├── agent.ts                         Main pipeline orchestrator (FileAgent)
│   ├── workerAgent.ts                   OpenAISession (the core LLM loop engine)
│   ├── LLMService.ts                    Singleton OpenAI client pointing to local llama.cpp
│   ├── EmbeddingService.ts              [DEPRECATED] Was in-process embedding; replaced by MCP
│   ├── ApiConfig.ts                     LLM server endpoint config
│   ├── prompt/
│   │   └── fileAgent.ts                 All system prompts for all agents
│   ├── state/
│   │   └── fileAgentState.ts            Shared pipeline state (the source of truth)
│   └── services/                        Categorization service implementations
├── tools/
│   ├── planningAgentTools.ts            Planning Agent tool implementations
│   ├── categorizationAgentTools.ts      Categorization Agent tool implementations
│   ├── executionAgentTools.ts           Execution Agent tool implementations
│   ├── fileCategorizationTools.ts       Document categorization sub-agent tools
│   ├── mcpClusteringAgentTools.ts       MCP clustering sub-agent tools (documents)
│   ├── mcpImageClusteringAgentTools.ts  MCP image clustering sub-agent tools
│   ├── imageClassificationTool.ts       Image worker tools
│   ├── fileClassificationTool.ts        Non-document classification tools
│   └── pipelineTools.ts                 HandOff and ErrorEncountered sentinels
├── electron/
│   └── ipcBridge.ts                     Electron IPC for real-time UI updates
├── renderer/                            React frontend (Vite)
└── file-organizer-mcp/                  Python MCP server (separate package)
    ├── pyproject.toml
    └── src/file_organizer_mcp/
        ├── server.py                    FastMCP server (MCP tool definitions)
        ├── clustering.py                ClusteringService (BERTopic pipeline)
        ├── image_clustering.py          Image description clustering
        ├── embeddings.py                Nomic embedding model wrapper
        ├── cache.py                     Embedding cache
        ├── discovery.py                 File discovery
        ├── extractors/                  Per-format text extractors
        ├── tuning.py                    Strategy to parameter mapping
        ├── run_store.py                 In-memory result store with TTL
        ├── queue.py                     Sequential job queue
        └── settings.py                 Configuration via environment variables
```

---

## Things to Highlight in the README

1. **Built on a 3-8B quantized model** — intentional constraint to prove small models can do complex agentic tasks.
2. **Fully local** — no cloud API calls for the LLM or embeddings. Everything runs on-device.
3. **Monorepo with two tech stacks** — TypeScript/Electron for the app, Python for the ML server.
4. **Divide-and-conquer orchestration** — the architectural answer to small model limitations.
5. **Human-in-the-loop at every categorization step** — users approve/modify every folder plan before any file moves.
6. **BERTopic + strategy tuning** — scientifically grounded clustering with guided parameter selection.
7. **Token economy throughout** — every design decision (shared state, two-step MCP results, compact summaries) reduces
   context window pressure on the small model.
8. **Electron desktop app** — packaged as a native desktop app (DMG on macOS).
