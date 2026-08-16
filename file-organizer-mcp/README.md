# File Organizer BERTopic MCP Server

A local, sequential Streamable HTTP MCP server that clusters PDF files with a Nomic GGUF embedding model and BERTopic. It returns structured topics, c-TF-IDF keywords/scores, file paths, cluster probabilities, outliers, skipped files, and cache statistics. It never moves, renames, deletes, or modifies source files.

## Phase 1 scope

- PDF only (`.pdf`, case-insensitive)
- Multiple-extension request shape retained for future phases
- Streamable HTTP MCP
- One clustering job at a time with a bounded waiting queue
- Persistent embedding-only cache with configurable expiration
- No OCR, CSV output, model serialization, folder naming, or file organization

## macOS setup

Python 3.11 or 3.12 is recommended.

```bash
cd file-organizer-mcp
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
```

`llama-cpp-python` should be built with Metal support on Apple Silicon:

```bash
CMAKE_ARGS="-DGGML_METAL=on" pip install "llama-cpp-python>=0.3.9,<0.4"
pip install -e .
```

If the first command reports the package is already installed without Metal, reinstall it:

```bash
CMAKE_ARGS="-DGGML_METAL=on" pip install --force-reinstall --no-cache-dir "llama-cpp-python>=0.3.9,<0.4"
pip install -e .
```

## Configure

```bash
cp .env.example .env
```

At minimum, update:

```dotenv
EMBEDDING_MODEL_PATH=/absolute/path/to/nomic-embed-text-v1.5.Q6_K.gguf
MCP_HOST=127.0.0.1
MCP_PORT=8000
```

Keep the server bound to `127.0.0.1` unless you add authentication and filesystem access controls. Phase 1 intentionally has no allowed-root restriction.

## Run

```bash
file-organizer-mcp
```

or:

```bash
python -m file_organizer_mcp
```

The default MCP endpoint is:

```text
http://127.0.0.1:8000/mcp
```

## Inspect the server

```bash
npx -y @modelcontextprotocol/inspector
```

Connect the inspector to `http://127.0.0.1:8000/mcp` using Streamable HTTP and call:

```json
{
  "folder_path": "/Users/your-name/Documents",
  "extensions": [".pdf"]
}
```

## Node client with `@openai/agents`

Install:

```bash
npm install @openai/agents
```

Example:

```ts
import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";

const fileMcp = new MCPServerStreamableHttp({
  url: "http://127.0.0.1:8000/mcp",
  name: "file-organizer",
  cacheToolsList: true,
  useStructuredContent: true,
});

await fileMcp.connect();

try {
  const agent = new Agent({
    name: "File Organization Agent",
    instructions: `
      Call cluster_files with a folder path and [".pdf"].
      For each regular topic, use its c-TF-IDF keywords and scores to propose a concise folder name.
      Treat outliers separately. Do not claim that the MCP server moved any files.
    `,
    mcpServers: [fileMcp],
    // Keep your existing local Llama-compatible model configuration here.
  });

  const result = await run(
    agent,
    "Analyze the PDFs in /Users/your-name/Documents",
  );
  console.log(result.finalOutput);
} finally {
  await fileMcp.close();
}
```

Exact model configuration depends on how your local Llama server is connected to the Agents SDK.

## Tool contract

### Input

```json
{
  "folder_path": "/absolute/or/relative/folder",
  "extensions": [".pdf"]
}
```

### Important responses

- `mode: "bertopic"`: three or more usable PDFs were clustered.
- `mode: "small_collection_fallback"`: one or two usable PDFs were grouped without fabricated keywords.
- `mode: "empty"`: no usable PDFs were found.
- `outliers`: BERTopic topic `-1`, returned separately.
- `skipped_files`: unreadable, scanned, too-large, too-short, or failed PDFs.

## Queue semantics

Only one clustering job runs at a time. Up to `MAX_QUEUED_JOBS` callers can wait. A client disconnect does not cancel the worker task; embedding/clustering continues and successful embeddings populate the cache. Run exactly one server process—multiple processes load multiple model copies and do not share the in-memory queue lock.

## Cache behavior

The cache stores embeddings and embedding statistics only. Its key includes file identity, file modification metadata, model fingerprint, extractor version, chunking parameters, task prefix, pooling strategy, and cache schema version. New or changed PDFs are embedded; unchanged PDFs reuse cache entries.

## Tests

```bash
pip install -e ".[dev]"
pytest
```

## Notes

- Scanned/image-only PDFs are reported as skipped; OCR is deferred.
- The server does not generate final folder names.
- The server does not write experiment CSV files.
- `THREADS` left empty uses half of available logical CPUs.

npx -y @modelcontextprotocol/inspector
file-organizer-mcp
