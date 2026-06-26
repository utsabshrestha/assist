import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AgentLog } from '../types/electron.js';

interface LogGroupProps {
  name: string;
  entries: AgentLog[];
}

export const LogGroup: React.FC<LogGroupProps> = ({ name, entries }) => {
  const [collapsed, setCollapsed] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!collapsed) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, collapsed]);

  return (
    <div className="border-l-2 border-[#e7e5e4] pl-3 pr-2 py-1.5">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-1.5 w-full text-left cursor-pointer"
      >
        <ChevronRight
          size={10}
          strokeWidth={2.5}
          className={`flex-shrink-0 text-[#a8a29e] transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
        />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#0284c7]">{name}</span>
        <span className="text-[10px] text-[#a8a29e] font-mono">· {entries.length} entries</span>
      </button>

      {!collapsed && (
        <div className="mt-1.5 max-h-48 overflow-y-auto rounded bg-[#1c1917] px-2.5 py-2">
          {entries.map((log, i) => (
            <p
              key={`${log.timestamp}-${i}`}
              className="text-[10px] text-[#d6d3d1] font-mono leading-relaxed whitespace-pre-wrap break-all"
            >
              {log.content}
            </p>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
};
