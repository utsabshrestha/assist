import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import type { AgentMessage, AgentLog, AgentStage, FolderReviewRequest, ScopeSelectionRequest, ExecutionConfirmRequest, CategorySummary, TodoItem } from './types/electron.js';
import { ChatPanel } from './components/ChatPanel.js';
import { LogPanel } from './components/LogPanel.js';
import { StageBadge } from './components/StageBadge.js';

export type TimelineRow =
  | { kind: 'message'; data: AgentMessage }
  | { kind: 'tool_call'; data: AgentLog };

const App: React.FC = () => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [stage, setStage] = useState<AgentStage>('idle');
  const [isThinking, setIsThinking] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [logPanelVisible, setLogPanelVisible] = useState(true);
  const [pendingFolderReview, setPendingFolderReview] = useState<FolderReviewRequest | null>(null);
  const [pendingScopeSelection, setPendingScopeSelection] = useState<ScopeSelectionRequest | null>(null);
  const [pendingExecutionConfirm, setPendingExecutionConfirm] = useState<ExecutionConfirmRequest | null>(null);
  const [todoList, setTodoList] = useState<TodoItem[]>([]);

  // Merge narration (messages) and pipeline milestones (logs) into one chronological
  // timeline feed for the main panel. Raw tool_call/tool_result/info/error entries stay
  // log-only (side panel) — every tool now carries its own narrated statusMessage, so the
  // raw call text would just be redundant noise here.
  const timelineRows = useMemo<TimelineRow[]>(() => {
    const rows: TimelineRow[] = [
      ...messages.map(data => ({ kind: 'message' as const, data })),
      ...logs.filter(l => l.type === 'pipeline').map(data => ({ kind: 'tool_call' as const, data })),
    ];
    return rows.sort((a, b) => a.data.timestamp - b.data.timestamp);
  }, [messages, logs]);

  // Drag-to-resize state
  const [chatWidth, setChatWidth] = useState(60);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ==========================================
  // IPC Event Listeners
  // ==========================================
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const removeMessage = api.onMessage((msg: AgentMessage) => {
      if (msg.type !== 'user') setIsThinking(false);
      setMessages(prev => {
        if (msg.groupId) {
          const existingIndex = prev.findIndex(m => m.groupId === msg.groupId);
          if (existingIndex !== -1) {
            const next = [...prev];
            next[existingIndex] = msg;
            return next;
          }
        }
        return [...prev, msg];
      });
    });

    const removeLog = api.onLog((log: AgentLog) => {
      setLogs(prev => [...prev, log]);
    });

    const removeStage = api.onStage(({ stage: s }) => {
      setStage(s);
      if (s === 'done') setIsThinking(false);
    });

    const removeFolderReviewRequest = api.onFolderReviewRequest((payload) => {
      setIsThinking(false);
      setPendingFolderReview(payload);
    });

    const removeScopeSelectionRequest = api.onScopeSelectionRequest((payload) => {
      setIsThinking(false);
      setPendingScopeSelection(payload);
    });

    const removeExecutionConfirmRequest = api.onExecutionConfirmRequest((payload) => {
      setIsThinking(false);
      setPendingExecutionConfirm(payload);
    });

    const removeTodoUpdate = api.onTodoUpdate(({ todoList }) => {
      setTodoList(todoList);
    });

    return () => {
      removeMessage();
      removeLog();
      removeStage();
      removeFolderReviewRequest();
      removeScopeSelectionRequest();
      removeExecutionConfirmRequest();
      removeTodoUpdate();
    };
  }, []);

  // ==========================================
  // Handlers
  // ==========================================
  const handleStart = useCallback((userMessage: string) => {
    setHasStarted(true);
    setIsThinking(true);
    window.electronAPI?.startAgent(userMessage);
  }, []);

  const handleFolderReviewSubmit = useCallback((inputId: string, action: 'approve' | 'message', message?: string) => {
    setPendingFolderReview(null);
    setIsThinking(true);
    window.electronAPI?.sendFolderReview(inputId, action, message);
  }, []);

  const handleScopeSelectionSubmit = useCallback((inputId: string, action: 'submit' | 'message', selected?: CategorySummary, message?: string) => {
    setPendingScopeSelection(null);
    setIsThinking(true);
    window.electronAPI?.sendScopeSelection(inputId, action, selected, message);
  }, []);

  const handleExecutionConfirmSubmit = useCallback((inputId: string, action: 'approve' | 'message', message?: string) => {
    setPendingExecutionConfirm(null);
    setIsThinking(true);
    window.electronAPI?.sendExecutionConfirm(inputId, action, message);
  }, []);

  // ==========================================
  // Drag-to-resize split pane
  // ==========================================
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const rawPercent = ((ev.clientX - rect.left) / rect.width) * 100;
      setChatWidth(Math.min(80, Math.max(40, rawPercent)));
    };

    const onUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const errorCount = logs.filter(l => l.type === 'error').length;

  return (
    <div className="flex flex-col h-screen bg-white overflow-hidden">

      {/* Titlebar */}
      <div className="titlebar-drag flex items-center justify-between h-11 px-4 flex-shrink-0
        bg-white border-b border-[#e7e5e4]">
        {/* macOS traffic light spacer */}
        <div className="w-16 flex-shrink-0" />

        {/* Center title */}
        <div className="titlebar-no-drag flex items-center gap-2">
          <span className="text-sm font-semibold text-[#1c1917]">File Assist</span>
          {hasStarted && <StageBadge stage={stage} size="sm" />}
        </div>

        {/* Right: Log panel toggle */}
        <div className="titlebar-no-drag flex items-center">
          <button
            id="toggle-log-panel"
            onClick={() => setLogPanelVisible(v => !v)}
            title={logPanelVisible ? 'Hide activity log' : 'Show activity log'}
            className={`
              flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
              transition-colors duration-150
              ${logPanelVisible
                ? 'bg-[#fdf1ec] text-[#c2613d] border border-[#e8cab8]'
                : 'text-[#78716c] hover:text-[#1c1917] hover:bg-[#f5f5f4]'
              }
            `}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
            </svg>
            Log
            {errorCount > 0 && (
              <span className="bg-red-100 text-red-600 text-[9px] px-1 py-px rounded font-bold">
                {errorCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Main content */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden min-h-0">

        {/* Chat panel */}
        <div
          className="flex-shrink-0 overflow-hidden"
          style={{
            width: logPanelVisible ? `${chatWidth}%` : '100%',
            transition: isDragging.current ? 'none' : 'width 0.15s ease',
          }}
        >
          <ChatPanel
            timelineRows={timelineRows}
            stage={stage}
            isThinking={isThinking}
            pendingFolderReview={pendingFolderReview}
            pendingScopeSelection={pendingScopeSelection}
            pendingExecutionConfirm={pendingExecutionConfirm}
            onFolderReviewSubmit={handleFolderReviewSubmit}
            onScopeSelectionSubmit={handleScopeSelectionSubmit}
            onExecutionConfirmSubmit={handleExecutionConfirmSubmit}
            hasStarted={hasStarted}
            onStart={handleStart}
          />
        </div>

        {/* Draggable divider */}
        {logPanelVisible && (
          <div className="split-divider" onMouseDown={handleDividerMouseDown} />
        )}

        {/* Log panel (includes Task List tab) */}
        {logPanelVisible && (
          <div className="flex-1 overflow-hidden min-w-0">
            <LogPanel logs={logs} todoList={todoList} isVisible={logPanelVisible} />
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
