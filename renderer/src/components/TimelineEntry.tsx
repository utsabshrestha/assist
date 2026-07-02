import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { AgentMessage, AgentLog, TodoStatus } from '../types/electron.js';
import { StageBadge, STAGE_AGENT_NAME } from './StageBadge.js';
import { StatusIcon } from './StatusIcon.js';

const TASK_UPDATE_STYLES: Record<TodoStatus, { text: string }> = {
  'not-started': { text: 'text-[#57534e]' },
  'in-progress': { text: 'text-[#a8502f]' },
  'completed':   { text: 'text-[#166534]' },
  'failed':      { text: 'text-[#991b1b]' },
  'blocked':     { text: 'text-[#92400e]' },
};

function inferTaskUpdateStatus(content: string): TodoStatus {
  const match = content.match(/→\s*(not-started|in-progress|completed|failed|blocked)\s*$/);
  return (match?.[1] as TodoStatus) ?? 'completed';
}

export type TimelineRowKind = 'message' | 'tool_call';

interface TimelineEntryProps {
  kind: TimelineRowKind;
  data: AgentMessage | AgentLog;
  /** Whether this row is the most recent one — drives the pulsing dot + flowing connector below it. */
  isLatest: boolean;
  /** Whether the segment below this row should render the flowing "still working" animation. */
  connectorActive: boolean;
  /** Whether to render a connector line below this row at all (false for the last row in the list). */
  showConnector: boolean;
  /** Whether to show the agent name + stage badge header (only the first row of a same-stage run). */
  showHeader: boolean;
}

export const TimelineEntry: React.FC<TimelineEntryProps> = ({ kind, data, isLatest, connectorActive, showConnector, showHeader }) => {
  const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (kind === 'tool_call') {
    // Despite the name, this row only ever carries 'pipeline'-type logs now (e.g. "Stage 1:
    // Planning..."), since every tool's own statusMessage covers individual tool-call narration.
    const log = data as AgentLog;
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center flex-shrink-0 w-5">
          <div className="w-2 h-2 rounded-full border-2 border-[#d6d3d1] bg-white mt-1.5" />
          {showConnector && (
            <div className={`flex-1 w-px mt-1 ${connectorActive ? 'timeline-connector-active' : 'bg-[#e7e5e4]'}`} />
          )}
        </div>
        <div className="flex-1 min-w-0 pb-3">
          <span className="text-xs text-[#78716c]">{log.content}</span>
        </div>
      </div>
    );
  }

  const msg = data as AgentMessage;

  if (msg.type === 'system') {
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center flex-shrink-0 w-5">
          {showConnector && (
            <div className={`flex-1 w-px mt-1 ${connectorActive ? 'timeline-connector-active' : 'bg-[#e7e5e4]'}`} />
          )}
        </div>
        <div className="flex-1 min-w-0 pb-3">
          <p className="text-xs text-[#a8a29e] italic">{msg.content}</p>
        </div>
      </div>
    );
  }

  if (msg.type === 'task_update') {
    const status = inferTaskUpdateStatus(msg.content);
    const style = TASK_UPDATE_STYLES[status];
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center flex-shrink-0 w-5">
          <div className="mt-0.5">
            <StatusIcon status={status} size={14} className={status === 'in-progress' ? 'animate-pulse' : ''} />
          </div>
          {showConnector && (
            <div className={`flex-1 w-px mt-1 ${connectorActive ? 'timeline-connector-active' : 'bg-[#e7e5e4]'}`} />
          )}
        </div>
        <div className="flex-1 min-w-0 pb-3 flex items-center gap-2">
          <span className={`text-xs font-medium ${style.text}`}>{msg.content}</span>
          <span className="text-[10px] text-[#d6d3d1]">{time}</span>
        </div>
      </div>
    );
  }

  // narration ('agent') — the default milestone row
  const agentName = STAGE_AGENT_NAME[msg.stage];
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center flex-shrink-0 w-5">
        <div className={`w-3 h-3 rounded-full border-2 mt-0.5 ${
          isLatest ? 'border-[#c2613d] bg-[#c2613d] animate-pulse' : 'border-[#059669] bg-[#059669]'
        }`} />
        {showConnector && (
          <div className={`flex-1 w-px mt-1 ${connectorActive ? 'timeline-connector-active' : 'bg-[#e7e5e4]'}`} />
        )}
      </div>
      <div className="flex-1 min-w-0 pb-3">
        {showHeader ? (
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[11px] font-semibold text-[#1c1917]">{agentName}</span>
            <StageBadge stage={msg.stage} size="sm" />
            <span className="text-[10px] text-[#a8a29e]">{time}</span>
          </div>
        ) : (
          <div className="mb-0.5">
            <span className="text-[10px] text-[#a8a29e]">{time}</span>
          </div>
        )}
        <div className="prose-agent text-[13px] text-[#44403c] leading-relaxed selectable">
          <ReactMarkdown>{msg.content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
};
