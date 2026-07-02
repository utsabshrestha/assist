import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { AgentMessage, AgentStage, FolderReviewRequest, ScopeSelectionRequest, ExecutionPlanRequest, CategorySummary } from '../types/electron.js';
import type { TimelineRow } from '../App.js';
import { TimelineEntry } from './TimelineEntry.js';
import { StageProgressBar } from './StageProgressBar.js';
import { FolderReviewPanel } from './FolderReviewPanel.js';
import { ScopeSelectionPanel } from './ScopeSelectionPanel.js';

interface ChatPanelProps {
  timelineRows: TimelineRow[];
  stage: AgentStage;
  isThinking: boolean;
  pendingFolderReview: FolderReviewRequest | null;
  pendingScopeSelection: ScopeSelectionRequest | null;
  pendingExecutionPlan: ExecutionPlanRequest | null;
  onFolderReviewSubmit: (inputId: string, action: 'approve' | 'message', message?: string) => void;
  onScopeSelectionSubmit: (inputId: string, action: 'submit' | 'message', selected?: CategorySummary, message?: string) => void;
  onOpenExecutionPlan: () => void;
  hasStarted: boolean;
  onStart: (msg: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  timelineRows,
  stage,
  isThinking,
  pendingFolderReview,
  pendingScopeSelection,
  pendingExecutionPlan,
  onFolderReviewSubmit,
  onScopeSelectionSubmit,
  onOpenExecutionPlan,
  hasStarted,
  onStart,
}) => {
  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [folderError, setFolderError] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [timelineRows, isThinking]);

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
    onStart(`Organize the folder at: ${selectedFolder}`);
  }, [selectedFolder, onStart]);

  const pendingPanel = pendingFolderReview || pendingScopeSelection || pendingExecutionPlan;
  const latestIndex = timelineRows.length - 1;

  // Only the first row of a contiguous run of same-stage 'agent' narration messages shows
  // the agent name + stage badge header — later rows in the run just show a timestamp.
  // Any non-agent row (pipeline milestone, system, task_update) breaks the run.
  const showHeaderFlags = useMemo(() => {
    let lastAgentStage: AgentStage | null = null;
    return timelineRows.map(row => {
      const isAgentMsg = row.kind === 'message' && (row.data as AgentMessage).type === 'agent';
      if (!isAgentMsg) {
        lastAgentStage = null;
        return false;
      }
      const stage = (row.data as AgentMessage).stage;
      const isFirst = stage !== lastAgentStage;
      lastAgentStage = stage;
      return isFirst;
    });
  }, [timelineRows]);

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">

      {/* Stage progress bar */}
      {hasStarted && (
        <div className="border-b border-[#e7e5e4] bg-[#fafafa] flex-shrink-0">
          <StageProgressBar stage={stage} />
        </div>
      )}

      {/* Timeline / welcome area */}
      <div className="flex-1 overflow-y-auto px-6 py-6">

        {/* Welcome screen */}
        {!hasStarted && (
          <div className="flex flex-col items-center justify-center h-full gap-8 pb-16">
            <div className="text-center">
              <h1 className="text-3xl font-semibold text-[#1c1917] tracking-tight mb-2" style={{ fontFamily: 'var(--font-display)' }}>File Assist</h1>
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

        {/* Activity timeline */}
        {hasStarted && (
          <div>
            {timelineRows.map((row, i) => (
              <TimelineEntry
                key={row.kind === 'message' ? (row.data.groupId ?? `${row.data.timestamp}-${i}`) : `${row.data.timestamp}-${i}`}
                kind={row.kind}
                data={row.data}
                isLatest={i === latestIndex}
                connectorActive={i === latestIndex && (isThinking || !pendingPanel)}
                showConnector={i < timelineRows.length - 1 || isThinking || !!pendingPanel}
                showHeader={showHeaderFlags[i]}
              />
            ))}

            {/* Structured panels — distinct "waiting on you" cards breaking the timeline's flow */}
            {pendingFolderReview && !isThinking && (
              <FolderReviewPanel
                request={pendingFolderReview}
                onSubmit={onFolderReviewSubmit}
              />
            )}

            {pendingScopeSelection && !isThinking && (
              <ScopeSelectionPanel
                request={pendingScopeSelection}
                onSubmit={onScopeSelectionSubmit}
              />
            )}

            {pendingExecutionPlan && !isThinking && (
              <button
                onClick={onOpenExecutionPlan}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#e8cab8] bg-gradient-to-br from-[#fdf1ec] to-[#f9f1ea] text-sm font-medium text-[#57341f] hover:shadow-md transition-shadow"
              >
                <ClipboardCheck size={15} strokeWidth={2} className="text-[#c2613d]" />
                Review & Confirm Plan
              </button>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
};
