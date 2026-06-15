import React, { useState } from 'react';
import type { AgentLog } from '../types/electron.js';

interface LogEntryProps {
  log: AgentLog;
}

const LOG_CONFIG: Record<string, { label: string; className: string; labelColor: string }> = {
  tool_call:   { label: 'Call',     className: 'log-call',     labelColor: 'text-[#7c3aed]' },
  tool_result: { label: 'Result',   className: 'log-result',   labelColor: 'text-[#059669]' },
  pipeline:    { label: 'Pipeline', className: 'log-pipeline', labelColor: 'text-[#d97706]' },
  error:       { label: 'Error',    className: 'log-error',    labelColor: 'text-[#dc2626]' },
  info:        { label: 'Info',     className: 'log-info',     labelColor: 'text-[#0284c7]' },
};

export const LogEntry: React.FC<LogEntryProps> = ({ log }) => {
  const [expanded, setExpanded] = useState(false);
  const config = LOG_CONFIG[log.type] ?? LOG_CONFIG['info']!;
  const time = new Date(log.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const isLong = log.content.length > 160;
  const displayContent = !expanded && isLong ? log.content.slice(0, 160) + '…' : log.content;

  return (
    <div className={`border-l-2 pl-3 pr-2 py-1.5 hover:bg-[#f5f5f4] transition-colors duration-100 ${config.className}`}>
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${config.labelColor}`}>
          {config.label}
        </span>
        {log.name && (
          <code className="text-[10px] text-[#57534e] bg-[#f5f5f4] border border-[#e7e5e4] px-1 py-px rounded">
            {log.name}
          </code>
        )}
        <span className="text-[9px] text-[#a8a29e] ml-auto font-mono flex-shrink-0">{time}</span>
      </div>
      <p
        className="text-[11px] text-[#57534e] font-mono leading-relaxed whitespace-pre-wrap break-all selectable"
        onClick={() => isLong && setExpanded(e => !e)}
      >
        {displayContent}
        {isLong && (
          <button
            className="ml-1 text-[#2563eb] hover:text-[#1d4ed8] text-[10px] font-sans font-medium underline"
            onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
          >
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </p>
    </div>
  );
};
