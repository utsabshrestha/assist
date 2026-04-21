# Plan: Master-Worker ReAct Agent Redesign

## Context
The current system dumps large file lists to workers in a single shot. Small LLMs (Qwen 3.5) can't process large contexts reliably. The user wants a proper ReAct architecture:
- **Analysis Worker** reads files incrementally in 50-file batches via a tool loop
- **Move Worker** moves files one at a time via a tool loop
- Workers never receive large data blobs — they call tools iteratively and build understanding progressively
- No file deletions; all operations bounded within a user-specified workspace path

## How `node-llama-cpp` ReAct Works
When `llmSession.prompt(text, { functions: tools })` is called, the framework:
1. Runs the LLM; if it emits a tool call, intercepts it
2. Executes the tool `handler`, feeds result back to the LLM as context
3. Loops until the LLM produces a final text response (no tool call)
→ A single `prompt()` call IS the multi-turn ReAct loop. No manual looping needed.

---

## Files to Modify (in order)

### 1. `src/state/fileAgentState.ts`
Add `workspacePath: string = ""` as the first field. This eliminates the circular import where `fileOrgTool.ts` imports `fileAgent` just for `.path`.

```typescript
export class fileAgentState {
    public workspacePath: string = "";   // set on analyzeFolder call
    public fileList: string[] = [];
    public filesCount: number = 0;
    public extensions: string[] = [];
    public lastReadInd: number = 0;      // pagination cursor; reset to 0 before move worker
}
```

---

### 2. `tools/fileTools.ts` — Complete Rewrite
Replace the broken `analyzeFolder`/`analyzeFiles` definitions with three clean tools. Export two separate tool sets.

#### Tool: `checkFolder(ProcessId)`
- Reads `state.workspacePath` (no `path` param — worker cannot control the path)
- Populates `state.fileList`, `state.filesCount`, `state.extensions`, resets `state.lastReadInd = 0`
- Returns `{ fileCount, extensions, message: "Call getNextFileBatch to page through files" }`
- Description: "Call this FIRST, ONCE. Returns file count and extensions."

#### Tool: `getNextFileBatch(ProcessId)`
- Returns `state.fileList.slice(state.lastReadInd, state.lastReadInd + 50)`
- Advances cursor: `state.lastReadInd += batch.length`
- Returns `{ files: string[], batchSize, processedSoFar, remaining, done: boolean }`
- Returns `"No more files. All files have been processed."` when exhausted
- Fix current bug: `slice(ind, ind + 50)` not `slice(ind, 50)`

#### Tool: `moveFile(ProcessId, source, destination)`
- Calls `fileUtil.ValidatePaths(state.workspacePath, [source, destination])` — boundary check
- Checks `destDir` exists with `fs.access(destDir)` — returns error if folder missing (worker cannot create folders)
- Calls `fs.rename(source, destination)` — no delete, only move
- Returns compact success/error string

#### Exports
```typescript
export const analysisWorkerTools = { checkFolder, getNextFileBatch };
export const moveWorkerTools = { getNextFileBatch, moveFile };
```
Analysis worker never gets `moveFile`. Move worker never gets `checkFolder`.

**Remove** the dead `fileState` reference (line 34 bug). **Fix** `state.fileList` assignment (was `Dirent[]`, must be `string[]`). **Fix** `ProcessId` typed as `number` → `string`.

---

### 3. `tools/workerAgent.ts`
Add one new method to `WorkerAgent` class:

```typescript
public async getWorkerAgentWithFunctionsReact(
    systemPrompt: string,
    userPrompt: string,
    toolFunction: Record<string, any>,
    workerName?: string
): Promise<string>
```
- Creates session, calls `llmSession.prompt(userPrompt, { functions: toolFunction, temperature: 0.7, topP: 0.9, topK: 20 })`
- Logs context usage and ends session
- Keep existing `getWorkerAgentWithGrammar` and `getWorkerAgentWithFunctions` methods intact

---

### 4. `src/prompt/fileAgent.ts`
Add three new exports. Keep existing prompts (they'll go unused but don't delete yet).

#### `analysisWorkerSystemPrompt`
Instructions for the analysis worker:
- Call `checkFolder` once → understand total scope
- Call `getNextFileBatch` in a loop until `done: true`
- Build running tally of file categories across batches
- When done, produce a concise plain-text summary (no JSON): total count, extensions, file groups with sample filenames, anomalies (dupes, large files, no-extension)
- Explicit rules: call `checkFolder` only once, stop calling `getNextFileBatch` after `done: true`

#### `moveWorkerSystemPrompt`
Instructions for the move worker:
- Call `getNextFileBatch` → get 50 files
- For each file, determine destination from the MOVE PLAN in the user prompt
- Call `moveFile(ProcessId, source, destination)` per file — source = `workspacePath + "/" + filename`
- Skip files with no matching destination (report them)
- Loop until `getNextFileBatch` returns `done: true`
- Final report: total moved, total skipped, errors

#### `moveWorkerUserPrompt(processId, workspacePath, movePlan, folderList): string`
Template function:
```
ProcessId: {processId}
Workspace path: {workspacePath}

MOVE PLAN:
{movePlan}

AVAILABLE DESTINATION FOLDERS:
{folderList}

Begin by calling getNextFileBatch to retrieve the first batch of files.
```

**Update `fileOrgMasterAgentSystemPrompt` Phase 6** to reference `createFolders` (new name) instead of `createFolder`.

---

### 5. `tools/fileOrgTool.ts` — Redesign
**Remove imports:** `minimatch`, `getLlama`, `GbnfJsonStringSchema`, `fileAgent` (circular dep)  
**Add imports:** `analysisWorkerTools`, `moveWorkerTools` from `./fileTools.js`; `analysisWorkerSystemPrompt`, `moveWorkerSystemPrompt`, `moveWorkerUserPrompt` from `../src/prompt/fileAgent.js`  
**Remove:** `buildMasterSummary`, `FLAG_DESCRIPTIONS` helpers

#### Tool 1: `analyzeFolder(path, ProcessId)` — Redesigned
```
handler:
  1. Create fileAgentRecord[ProcessId] = new fileAgentState()
  2. Set state.workspacePath = params.path
  3. Call workerAgent.getWorkerAgentWithFunctionsReact(
       analysisWorkerSystemPrompt,
       "ProcessId: {ProcessId}\nBegin analysis now. Start by calling checkFolder.",
       analysisWorkerTools,
       "AnalysisWorker"
     )
  4. Return the worker's final text summary
```

#### Tool 2: `createFolders(ProcessId, folders: string[])` — Renamed + Validated
- Validates all paths via `fileUtil.ValidatePaths(state.workspacePath, folders)` before creating
- Params changed from top-level array to `{ ProcessId: string, folders: string[] }` object (safer schema)
- Returns per-folder success/failure lines

#### Tool 3: `executeMovePlan(ProcessId, instruction, folders)` — Redesigned
```
handler:
  1. Get state from fileAgentRecord[ProcessId]
  2. Reset state.lastReadInd = 0  ← CRITICAL: analysis worker exhausted the cursor
  3. Build folderList string from pipe-separated folders
  4. Call workerAgent.getWorkerAgentWithFunctionsReact(
       moveWorkerSystemPrompt,
       moveWorkerUserPrompt(ProcessId, workspacePath, instruction, folderList),
       moveWorkerTools,
       "MoveWorker"
     )
  5. Return the worker's final move report
```

---

### 6. `src/agent.ts` — Minor Fixes
1. Remove hardcoded path, use env var: `readonly path = process.env.WORKSPACE_PATH ?? "/Users/utsabshrestha/code/download"`
2. Remove unused inner `while(true)` loop that immediately breaks — just call `llmSession.prompt()` directly
3. Fix template literal bug: `` `userInput \n\n ProcessId: ${crypto.randomUUID()}` `` → `` `${userInput}\n\nProcessId: ${crypto.randomUUID()}` ``

---

## Data Flow (New)

```
User: "Organize /foo/bar"  ProcessId=X
  → Master calls analyzeFolder("/foo/bar", "X")
      Creates state: { workspacePath: "/foo/bar", fileList: [], lastReadInd: 0 }
      Spawns AnalysisWorker (ReAct loop):
        → checkFolder("X")        : reads /foo/bar → fileList populated, filesCount set
        → getNextFileBatch("X")   : files[0..49], remaining=N
        → getNextFileBatch("X")   : files[50..99], remaining=N-50
        → ... until done:true
        → Returns plain-text summary
      Master returns summary to user

User + Master discuss plan, type CONFIRM
  → Master calls createFolders("X", ["/foo/bar/Images", "/foo/bar/Docs"])
      Validates + creates folders

  → Master calls executeMovePlan("X", "move images to Images, docs to Docs", "/foo/bar/Images|/foo/bar/Docs")
      Resets state.lastReadInd = 0
      Spawns MoveWorker (ReAct loop):
        → getNextFileBatch("X")   : files[0..49]
        → moveFile("X", "/foo/bar/photo.jpg", "/foo/bar/Images/photo.jpg")
        → moveFile("X", "/foo/bar/report.pdf", "/foo/bar/Docs/report.pdf")
        → ... (more moves)
        → getNextFileBatch("X")   : files[50..99]
        → ... until done:true
        → Returns move report: "Moved 42 files, skipped 3"
      Master reports to user
```

---

## Safety Constraints
- `moveFile` enforces `ValidatePaths` — any path outside workspace returns error (not crash)
- `moveFile` forbids creating folders (`fs.access` check on destDir)
- Move worker never receives `checkFolder` — cannot reset the file list
- Analysis worker never receives `moveFile` — cannot move files during analysis
- Master prompt still requires explicit CONFIRM before calling `executeMovePlan`

---

## Verification
1. Run `npx tsx src/agent.ts` (or via `npm start`)
2. Provide a test folder path with 10–15 files of mixed types
3. Verify AnalysisWorker logs show multiple `getNextFileBatch` calls
4. Confirm master presents accurate file summary
5. Provide folder plan, type CONFIRM
6. Verify MoveWorker logs show individual `moveFile` calls
7. Check files physically moved to correct subdirectories
8. Attempt to move a file outside workspace — verify error is returned cleanly
9. Test with 60+ files to verify pagination (2+ batch cycles)
