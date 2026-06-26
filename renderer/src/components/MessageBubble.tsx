import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { AgentMessage, TodoStatus } from '../types/electron.js';
import { StageBadge, STAGE_AGENT_NAME } from './StageBadge.js';
import { StatusIcon } from './StatusIcon.js';

const TASK_UPDATE_STYLES: Record<TodoStatus, { bg: string; border: string; text: string; time: string }> = {
  'not-started': { bg: 'bg-[#f5f5f4]', border: 'border-[#e7e5e4]', text: 'text-[#57534e]', time: 'text-[#d6d3d1]' },
  'in-progress': { bg: 'bg-[#eff6ff]', border: 'border-[#bfdbfe]', text: 'text-[#1d4ed8]', time: 'text-[#93c5fd]' },
  'completed':   { bg: 'bg-[#f0fdf4]', border: 'border-[#bbf7d0]', text: 'text-[#166534]', time: 'text-[#86efac]' },
  'failed':      { bg: 'bg-[#fef2f2]', border: 'border-[#fecaca]', text: 'text-[#991b1b]', time: 'text-[#fca5a5]' },
  'blocked':     { bg: 'bg-[#fffbeb]', border: 'border-[#fde68a]', text: 'text-[#92400e]', time: 'text-[#fcd34d]' },
};

function inferTaskUpdateStatus(content: string): TodoStatus {
  const match = content.match(/→\s*(not-started|in-progress|completed|failed|blocked)\s*$/);
  return (match?.[1] as TodoStatus) ?? 'completed';
}

interface MessageBubbleProps {
  message: AgentMessage;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit'
  });

  if (message.type === 'user') {
    return (
      <div className="flex justify-end gap-3 animate-fade-in">
        <div className="max-w-[75%] flex flex-col items-end gap-1">
          <span className="text-[10px] text-[#a8a29e] mr-0.5">{time}</span>
          <div className="bubble-user px-4 py-2.5 selectable">
            <div className="prose-user text-sm text-white leading-relaxed">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (message.type === 'task_update') {
    const agentName = STAGE_AGENT_NAME[message.stage];
    const status = inferTaskUpdateStatus(message.content);
    const style = TASK_UPDATE_STYLES[status];
    return (
      <div className="flex gap-3 animate-fade-in">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#f5f5f4] border border-[#e7e5e4]
          flex items-center justify-center mt-0.5">
          <span className="text-xs font-semibold text-[#57534e]">
            {agentName[0]}
          </span>
        </div>
        <div className="max-w-[82%] flex flex-col gap-1">
          <div className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg ${style.bg} border ${style.border}`}>
            <StatusIcon status={status} size={13} />
            <span className={`text-xs font-medium ${style.text}`}>{message.content}</span>
            <span className={`text-[10px] ml-1 ${style.time}`}>{time}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.type === 'system') {
    return (
      <div className="flex justify-center animate-fade-in my-1">
        <div className="bubble-system px-4 py-2">
          <p className="text-xs text-[#78716c] text-center">{message.content}</p>
        </div>
      </div>
    );
  }

  // type === 'agent'
  const agentName = STAGE_AGENT_NAME[message.stage];

  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#f5f5f4] border border-[#e7e5e4]
        flex items-center justify-center mt-0.5">
        <span className="text-xs font-semibold text-[#57534e]">
          {agentName[0]}
        </span>
      </div>
      <div className="max-w-[82%] flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[#1c1917]">{agentName}</span>
          <StageBadge stage={message.stage} size="sm" />
          <span className="text-[10px] text-[#a8a29e] ml-auto">{time}</span>
        </div>
        <div className="bubble-agent px-4 py-3 selectable">
          <div className="prose-agent text-sm text-[#1c1917] leading-relaxed">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
};

export const TypingIndicator: React.FC = () => (
  <div className="flex gap-3 animate-fade-in">
    <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#f5f5f4] border border-[#e7e5e4]
      flex items-center justify-center mt-0.5">
      <span className="text-xs font-semibold text-[#57534e]">A</span>
    </div>
    <div className="bubble-agent px-4 py-3.5 flex items-center gap-1">
      <span className="typing-dot w-1.5 h-1.5 bg-[#a8a29e] rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-[#a8a29e] rounded-full" />
      <span className="typing-dot w-1.5 h-1.5 bg-[#a8a29e] rounded-full" />
    </div>
  </div>
);
