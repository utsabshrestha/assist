import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentLog } from '../types/electron.js';
import { useSmartScroll } from '../hooks/useSmartScroll.js';
import { JsonTree } from './JsonTree.js';

interface LogGroupProps {
  name: string;
  entries: AgentLog[];
}

function tryParseJson(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export const LogGroup: React.FC<LogGroupProps> = ({ name, entries }) => {
  const [collapsed, setCollapsed] = useState(true);
  const { scrollRef, bottomRef, isAtBottom, scrollToBottom } = useSmartScroll([entries.length, collapsed]);

  return (
    <div className="log-group">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="log-group-header"
      >
        <ChevronRight
          size={10}
          strokeWidth={2.5}
          className={`flex-shrink-0 text-[#4a5568] transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
        />
        <span className="log-group-name">{name}</span>
        <span className="log-group-count">· {entries.length} results</span>
      </button>

      {!collapsed && (
        <div className="log-group-body relative">
          <div ref={scrollRef} className="log-group-scroll">
            {entries.map((log, i) => {
              const json = tryParseJson(log.content);
              return (
                <div key={`${log.timestamp}-${i}`} className="log-group-item">
                  {json ? (
                    <div className="selectable">
                      <JsonTree data={json} depth={0} maxDepth={1} />
                    </div>
                  ) : (
                    <p className="log-group-text selectable">{log.content}</p>
                  )}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {!isAtBottom && (
            <div className="absolute bottom-2 left-0 right-0 flex justify-center pointer-events-none">
              <button
                onClick={scrollToBottom}
                className="pointer-events-auto flex items-center gap-1 px-2.5 py-1 rounded-full
                  bg-[#2a3048]/90 backdrop-blur-sm text-[#8892b0] text-[9px] font-medium
                  shadow hover:bg-[#323a55] transition-all duration-150"
              >
                <ChevronDown size={9} strokeWidth={2.5} />
                more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
