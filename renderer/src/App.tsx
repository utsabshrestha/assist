import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { AgentMessage, AgentLog, AgentStage } from './types/electron.js';
import { ChatPanel } from './components/ChatPanel.js';
import { LogPanel } from './components/LogPanel.js';
import { StageBadge } from './components/StageBadge.js';

const App: React.FC = () => {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [stage, setStage] = useState<AgentStage>('idle');
  const [isThinking, setIsThinking] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [logPanelVisible, setLogPanelVisible] = useState(true);
  const [pendingInput, setPendingInput] = useState<{ promptLabel: string; inputId: string } | null>(null);

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
      setMessages(prev => [...prev, msg]);
    });

    const removeLog = api.onLog((log: AgentLog) => {
      setLogs(prev => [...prev, log]);
    });

    const removeStage = api.onStage(({ stage: s }) => {
      setStage(s);
      if (s === 'done') setIsThinking(false);
    });

    const removeInputRequest = api.onInputRequest((payload) => {
      setIsThinking(false);
      setPendingInput(payload);
    });

    return () => {
      removeMessage();
      removeLog();
      removeStage();
      removeInputRequest();
    };
  }, []);

  // ==========================================
  // Handlers
  // ==========================================
  const handleStart = useCallback((userMessage: string) => {
    setHasStarted(true);
    setIsThinking(true);
    setMessages([{
      type: 'user',
      stage: 'idle',
      content: userMessage,
      timestamp: Date.now(),
    }]);
    window.electronAPI?.startAgent(userMessage);
  }, []);

  const handleSendMessage = useCallback((text: string) => {
    setMessages(prev => [...prev, {
      type: 'user', stage, content: text, timestamp: Date.now()
    }]);
  }, [stage]);

  const handleSubmitInput = useCallback((inputId: string, value: string) => {
    setPendingInput(null);
    setIsThinking(true);
    window.electronAPI?.sendInput(inputId, value);
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
                ? 'bg-[#eff6ff] text-[#2563eb] border border-[#bfdbfe]'
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
            messages={messages}
            stage={stage}
            isThinking={isThinking}
            pendingInput={pendingInput}
            onSendMessage={handleSendMessage}
            onSubmitInput={handleSubmitInput}
            hasStarted={hasStarted}
            onStart={handleStart}
          />
        </div>

        {/* Draggable divider */}
        {logPanelVisible && (
          <div className="split-divider" onMouseDown={handleDividerMouseDown} />
        )}

        {/* Log panel */}
        {logPanelVisible && (
          <div className="flex-1 overflow-hidden min-w-0">
            <LogPanel logs={logs} isVisible={logPanelVisible} />
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
