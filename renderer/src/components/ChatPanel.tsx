import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { AgentMessage, AgentStage, FolderReviewRequest } from '../types/electron.js';
import { MessageBubble, TypingIndicator } from './MessageBubble.js';
import { StageProgressBar } from './StageProgressBar.js';
import { FolderReviewPanel } from './FolderReviewPanel.js';

interface ChatPanelProps {
  messages: AgentMessage[];
  stage: AgentStage;
  isThinking: boolean;
  pendingInput: { promptLabel: string; inputId: string } | null;
  pendingFolderReview: FolderReviewRequest | null;
  onSendMessage: (text: string) => void;
  onSubmitInput: (inputId: string, value: string) => void;
  onFolderReviewSubmit: (inputId: string, action: 'approve' | 'message', message?: string) => void;
  hasStarted: boolean;
  onStart: (msg: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  stage,
  isThinking,
  pendingInput,
  pendingFolderReview,
  onSendMessage,
  onSubmitInput,
  onFolderReviewSubmit,
  hasStarted,
  onStart,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [folderError, setFolderError] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  useEffect(() => {
    if (pendingInput || !hasStarted) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [pendingInput, hasStarted]);

  const inputDisabled = isThinking || (hasStarted && pendingInput === null && pendingFolderReview === null);

  const getPlaceholder = () => {
    if (!hasStarted) return 'Describe what you want to organize (optional)…';
    if (isThinking) return 'Agent is working…';
    if (pendingFolderReview) return 'Use the folder review panel above to respond…';
    if (pendingInput) return `${pendingInput.promptLabel} — type your response…`;
    return 'Waiting for agent…';
  };

  // Native folder picker
  const handleSelectFolder = useCallback(async () => {
    const folderPath = await window.electronAPI?.selectFolder();
    if (folderPath) {
      setSelectedFolder(folderPath);
      setFolderError('');
    }
  }, []);

  const handleStart = useCallback(() => {
    if (!selectedFolder) {
      setFolderError('Please select a folder to organize.');
      return;
    }
    const message = inputValue.trim()
      ? `Organize the folder at: ${selectedFolder}\n\nAdditional instructions: ${inputValue.trim()}`
      : `Organize the folder at: ${selectedFolder}`;
    onStart(message);
    setInputValue('');
  }, [selectedFolder, inputValue, onStart]);

  const handleSubmitInput = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || inputDisabled) return;

    if (pendingInput) {
      onSubmitInput(pendingInput.inputId, trimmed);
    }
    setInputValue('');
  }, [inputValue, inputDisabled, pendingInput, onSubmitInput]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!hasStarted) handleStart();
      else handleSubmitInput();
    }
  };

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">

      {/* Stage progress bar */}
      {hasStarted && (
        <div className="border-b border-[#e7e5e4] bg-[#fafafa] flex-shrink-0">
          <StageProgressBar stage={stage} />
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">

        {/* Welcome screen */}
        {!hasStarted && (
          <div className="flex flex-col items-center justify-center h-full gap-8 pb-16">
            <div className="text-center">
              <h1 className="text-2xl font-semibold text-[#1c1917] tracking-tight mb-2">File Assist</h1>
              <p className="text-sm text-[#78716c] max-w-sm leading-relaxed">
                Select a folder and let the File assist help you plan, categorize, and organize your files.
              </p>
            </div>

            {/* Folder picker */}
            <div className="w-full max-w-md space-y-3">
              <label className="block text-xs font-semibold text-[#57534e] uppercase tracking-wider">
                Folder to organize
              </label>

              <div className="flex gap-2">
                <div className={`
                  flex-1 flex items-center px-3 py-2.5 rounded-lg border bg-[#fafafa] min-w-0
                  ${folderError ? 'border-red-400' : 'border-[#d6d3d1]'}
                `}>
                  {selectedFolder ? (
                    <span className="text-sm text-[#1c1917] truncate font-mono" title={selectedFolder}>
                      {selectedFolder}
                    </span>
                  ) : (
                    <span className="text-sm text-[#a8a29e]">No folder selected</span>
                  )}
                </div>
                <button
                  id="select-folder-btn"
                  onClick={handleSelectFolder}
                  className="flex-shrink-0 px-4 py-2.5 text-sm font-medium rounded-lg border border-[#d6d3d1]
                    text-[#1c1917] bg-white hover:bg-[#f5f5f4] transition-colors duration-150"
                >
                  Browse…
                </button>
              </div>

              {folderError && (
                <p className="text-xs text-red-500">{folderError}</p>
              )}

              {/* Optional instructions */}
              <div>
                <label className="block text-xs font-semibold text-[#57534e] uppercase tracking-wider mb-2">
                  Instructions (optional)
                </label>
                <textarea
                  ref={inputRef}
                  id="start-instructions"
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. Keep PDF files separate, group images by date…"
                  rows={2}
                  className="input-field w-full px-3 py-2.5 text-sm resize-none selectable"
                />
              </div>

              <button
                id="start-agent-btn"
                onClick={handleStart}
                disabled={!selectedFolder}
                className="w-full py-2.5 text-sm font-medium rounded-lg send-btn"
              >
                Start organizing
              </button>
            </div>
          </div>
        )}

        {/* Messages */}
        {messages.map((msg, i) => (
          <MessageBubble key={`${msg.timestamp}-${i}`} message={msg} />
        ))}

        {/* Folder review panel — rendered inline after messages */}
        {pendingFolderReview && !isThinking && (
          <FolderReviewPanel
            request={pendingFolderReview}
            onSubmit={onFolderReviewSubmit}
          />
        )}

        {isThinking && <TypingIndicator />}

        {/* Waiting-for-input hint */}
        {pendingInput && !isThinking && (
          <div className="flex items-center gap-2 px-3 py-2 bg-[#eff6ff] border border-[#bfdbfe] rounded-lg text-xs text-[#2563eb]">
            <div className="w-1.5 h-1.5 rounded-full bg-[#2563eb] animate-pulse flex-shrink-0" />
            Agent is waiting for your input
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area (only when session started) */}
      {hasStarted && (
        <div className="flex-shrink-0 border-t border-[#e7e5e4] bg-[#fafafa] px-5 py-3.5">
          {pendingInput && !isThinking && (
            <div className="mb-2">
              <span className="text-[10px] font-semibold text-[#2563eb] uppercase tracking-wider">
                {pendingInput.promptLabel}
              </span>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              id="chat-input"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={inputDisabled}
              placeholder={getPlaceholder()}
              rows={1}
              className="input-field flex-1 px-3.5 py-2.5 text-sm resize-none min-h-[40px] max-h-[100px] overflow-y-auto selectable"
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 100) + 'px';
              }}
            />
            <button
              id="send-button"
              onClick={handleSubmitInput}
              disabled={!inputValue.trim() || inputDisabled}
              className="send-btn px-3.5 py-2.5 text-sm font-medium flex-shrink-0 h-[40px] flex items-center gap-1.5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
              Send
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-[#a8a29e]">
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      )}
    </div>
  );
};
