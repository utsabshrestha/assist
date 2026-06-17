# File Assist — Electron Desktop App Walkthrough

## What Was Built

The File Assist AI agent was migrated from a Node.js console application to a native macOS desktop app using **Electron + React + Tailwind CSS v4**, with a classic, clean UI inspired by Claude's design language.

---

## Architecture

```
Electron Main Process (Node.js)
  ├── electron/main.ts        — BrowserWindow, IPC handlers, folder dialog
  ├── electron/ipcBridge.ts   — Central event bus (emitLog, emitAgentMessage, requestUserInput)
  ├── electron/preload.ts     — Context bridge exposing safe API to renderer
  ├── src/agent.ts            — Pipeline orchestrator (Planning → Categ → Execution)
  ├── src/workerAgent.ts      — OpenAI session wrapper
  └── tools/                  — All agent tools (now IPC-aware)

Renderer Process (React + Vite)
  └── renderer/src/
      ├── App.tsx             — Root layout with toggleable split pane
      ├── components/
      │   ├── ChatPanel       — Main chat area with folder picker
      │   ├── LogPanel        — Activity log with filter tabs
      │   ├── MessageBubble   — Agent/user bubbles with ReactMarkdown
      │   ├── StageBadge      — Phase indicator badges
      │   ├── StageProgressBar — Numbered step progress (Planning → Done)
      │   └── LogEntry        — Individual log event row
      └── types/electron.d.ts — IPC API type definitions
```

---

## Key Changes to Existing Code

| File | Change |
|------|--------|
| `src/agent.ts` | Removed all `readline` stdin; `chatLoop()` now takes `initialUserMessage` param; emits IPC events |
| `src/workerAgent.ts` | `process.stdout.write` → `emitAgentMessage()` and `emitLog()` via IPC bridge |
| `tools/pipelineTools.ts` | All `console.log` → `emitLog()` |
| `tools/planningAgentTools.ts` | All `console.log` → `emitLog()`, `Dirent` type fixed |
| `tools/categorizationAgentTools.ts` | All `readline.createInterface/rl.question` → `await requestUserInput()` |
| `tools/executionAgentTools.ts` | Confirmation prompt → `await requestUserInput()`; plan printed to log panel |

---

## UI Features

- **Classic white theme** — clean, minimal, typography-forward (Claude-style)
- **Split pane** — 60/40 chat/log, draggable divider, toggleable via Log button
- **Folder picker** — Native OS dialog (Browse… button → `dialog.showOpenDialog`)
- **Markdown rendering** — Agent responses parsed with `react-markdown`
- **Dynamic agent names** — Planner / Categorization / Execution Agent per phase
- **Activity Log** — Color-coded border types with filter tabs (All/Calls/Results/Pipeline/Errors)
- **Stage progress bar** — Numbered steps: Planning → Categorizing → Executing → Complete
- **Typing indicator** — Subtle dots while agent processes

---

## How to Run

```bash
# Development (hot-reload)
npm run electron:dev

# Debug run vite
npm run dev:renderer

# Build for production
npm run electron:build
```

> [!IMPORTANT]
> The local LLaMA.cpp server must be running at `http://127.0.0.1:8080` before starting a session.
