# Transition to Electron + React + Tailwind Desktop App

## Background

The current app is a Node.js console application that runs a 3-stage AI pipeline (Planning → Categorization → Execution) for organizing files. All communication happens via `process.stdin`/`process.stdout`. The goal is to wrap this into a native desktop app with a chat-style UI using **Electron + React + Tailwind CSS**, with:

- A **main chat panel** showing agent messages (like a chat conversation)
- A **side log panel** showing all tool calls, pipeline transitions, and system logs
- **User input** replacing the current `readline` prompts
- The backend agent logic running in Electron's **main process**, sending events to the **renderer (React UI)** via IPC

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Electron Main Process               │
│  ┌────────────────────────────────────────────────┐ │
│  │  agent.ts (FileAgent) — pipeline orchestrator  │ │
│  │  workerAgent.ts (OpenAISession)                │ │
│  │  All tools — planning / categ / execution      │ │
│  └────────────────────┬───────────────────────────┘ │
│                       │ ipcMain.handle / .emit       │
└───────────────────────┼─────────────────────────────┘
                        │ IPC Bridge (preload.ts)
┌───────────────────────┼─────────────────────────────┐
│             Electron Renderer (React)                │
│  ┌────────────────────▼───────────────────────────┐ │
│  │  App.tsx                                       │ │
│  │  ├── ChatPanel (main messages + user input)    │ │
│  │  └── LogPanel (tool calls, system logs)        │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### IPC Event Design

| Direction | Channel | Payload |
|---|---|---|
| main → renderer | `agent:message` | `{ type: 'agent'\|'user'\|'system', stage: string, content: string }` |
| main → renderer | `agent:log` | `{ type: 'tool_call'\|'tool_result'\|'pipeline'\|'error', name?: string, content: string }` |
| main → renderer | `agent:stage` | `{ stage: 'planning'\|'categorization'\|'execution'\|'done' }` |
| main → renderer | `agent:input_request` | `{ promptLabel: string, inputId: string }` |
| renderer → main | `agent:user_input` | `{ inputId: string, value: string }` |
| renderer → main | `agent:start` | `{ userMessage: string }` |

---

## Key Design Decisions

> [!IMPORTANT]
> **User Input Bridge**: All `readline` prompts (in `agent.ts`, `categorizationAgentTools.ts`, `executionAgentTools.ts`) will be replaced by an async IPC-based input bridge. The main process will emit `agent:input_request` and await a `Promise` that resolves when `agent:user_input` is received from the renderer. This cleanly replaces every `rl.question(...)` call with a `await requestUserInput(label)` helper.

> [!IMPORTANT]
> **No separate backend server**: All agent code runs in Electron's main process — no HTTP server needed. The existing Node.js module resolution stays intact since Electron's main process is Node.js.

> [!NOTE]
> **Logging**: `console.log` calls in tools/agents will be intercepted by patching them in the main process to also emit `agent:log` events to the renderer. Original console output preserved for debugging.

---

## Open Questions

> [!IMPORTANT]
> **Vite vs CRA**: I plan to use **Vite** (with `@vitejs/plugin-react`) for the React renderer — faster HMR and better Electron integration. Is this acceptable, or do you have a preference?

> [!IMPORTANT]
> **Electron Window Layout**: Should the log panel always be visible, or should it be a collapsible/toggleable sidebar? My default plan is a toggleable split-pane (chat 60% / logs 40%).

> [!NOTE]
> **Tailwind Version**: The user requested Tailwind CSS. I'll use **Tailwind CSS v4** (latest). Please confirm if v3 is preferred instead.

---

## Proposed Changes

### Phase 1 — Electron + Vite + React + Tailwind Scaffold

#### [NEW] `electron/main.ts`
The Electron main process entry point. Initializes the `BrowserWindow`, sets up IPC handlers, and imports/runs the adapted `FileAgent`.

#### [NEW] `electron/preload.ts`
The context bridge exposing safe IPC methods to the renderer: `window.electronAPI.sendInput(...)`, `window.electronAPI.onMessage(...)`, `window.electronAPI.onLog(...)`.

#### [NEW] `electron/ipcBridge.ts`
A shared event emitter / helper module that:
- Exposes `emitAgentMessage(...)`, `emitLog(...)`, `requestUserInput(label)` functions
- `requestUserInput` returns a `Promise<string>` that resolves via IPC

#### [NEW] `renderer/` directory
Vite + React app:
- `renderer/index.html`
- `renderer/src/main.tsx`
- `renderer/src/App.tsx`
- `renderer/src/components/ChatPanel.tsx`
- `renderer/src/components/LogPanel.tsx`
- `renderer/src/components/MessageBubble.tsx`
- `renderer/src/components/StageBadge.tsx`
- `renderer/src/index.css` (Tailwind + custom tokens)

---

### Phase 2 — Adapt Agent Core (Main Process Side)

#### [MODIFY] `src/agent.ts`
- Remove all `readline` imports and `rl.question` calls
- Replace `process.stdin` with the IPC input bridge (`requestUserInput`)
- Replace `console.log` stage headers with `emitAgentMessage(...)` calls
- The `chatLoop()` becomes a function callable from `electron/main.ts`

#### [MODIFY] `src/workerAgent.ts`
- `process.stdout.write(...)` for assistant messages → `emitAgentMessage({ type: 'agent', ... })`
- `process.stdout.write(...)` for tool calls → `emitLog({ type: 'tool_call', ... })`

#### [MODIFY] `tools/pipelineTools.ts`
- `console.log` pipeline/error messages → `emitLog({ type: 'pipeline', ... })`

#### [MODIFY] `tools/planningAgentTools.ts`
- `console.log` tool call logs → `emitLog({ type: 'tool_call', ... })`

#### [MODIFY] `tools/categorizationAgentTools.ts`
- Replace all `readline.createInterface` / `rl.question` user input loops with `await requestUserInput(label)`
- `console.log` → `emitLog(...)`

#### [MODIFY] `tools/executionAgentTools.ts`
- Replace `readline` confirmation prompt in `getFinalPlanConfirmation` with `await requestUserInput(...)`
- `console.log` → `emitLog(...)`

---

### Phase 3 — Build Configuration

#### [MODIFY] `package.json`
Add scripts:
- `"electron:dev"` — starts Vite dev server + Electron together
- `"electron:build"` — builds renderer + packages with `electron-builder`

Add dev dependencies:
- `electron`, `electron-builder`
- `vite`, `@vitejs/plugin-react`
- `react`, `react-dom`, `@types/react`, `@types/react-dom`
- `tailwindcss`, `@tailwindcss/vite`
- `concurrently`, `wait-on`

#### [NEW] `vite.config.ts`
Vite config for the renderer only (not the main process).

#### [NEW] `electron-builder.yml`
Electron builder config for macOS packaging.

---

## UI Design

**Main Chat Panel:**
- Dark theme, premium design (deep navy/slate + purple accent)
- Agent messages displayed as chat bubbles with agent name + stage badge
- User messages right-aligned
- Typing indicator animation while agent is processing
- Stage progress indicator at the top (Planning → Categorization → Execution)
- Input box at the bottom (activates when agent requests input)

**Log Panel (sidebar):**
- Collapsible with smooth transition
- Color-coded log entries: 🔧 Tool Call (purple), ✅ Tool Result (green), ⚡ Pipeline (yellow), ❌ Error (red)
- Auto-scrolls to latest log
- Each tool call is expandable to show arguments/result

---

## Verification Plan

### Automated Tests
- `npm run electron:dev` — verify dev window opens with no errors
- Run a planning session via the UI and verify messages appear in both panels

### Manual Verification
- Start a file organization session: messages appear in chat panel
- Tool calls appear in log panel in real time
- User input prompts activate the input box
- Pipeline handoffs (`Planning → Categorization → Execution`) update the stage indicator
- Plan confirmation dialog works via the UI input
