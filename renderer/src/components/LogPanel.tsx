import React, { useEffect, useRef, useState } from 'react';
import type { AgentLog, TodoItem } from '../types/electron.js';
import { LogEntry } from './LogEntry.js';
import { TodoListPanel } from './TodoListPanel.js';

interface LogPanelProps {
  logs: AgentLog[];
  todoList: TodoItem[];
  isVisible: boolean;
}

const FILTERS = [
  { value: 'tasks',       label: 'Task List' },
  { value: 'all',         label: 'All'      },
  { value: 'tool_call',   label: 'Calls'    },
  { value: 'tool_result', label: 'Results'  },
  { value: 'pipeline',    label: 'Pipeline' },
  { value: 'error',       label: 'Errors'   },
];

export const LogPanel: React.FC<LogPanelProps> = ({ logs, todoList, isVisible }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<string>('tasks');

  useEffect(() => {
    if (filter !== 'tasks') bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, filter]);

  const filteredLogs = filter === 'all' ? logs : logs.filter(l => l.type === filter);
  const errorCount = logs.filter(l => l.type === 'error').length;

  return (
    <div className={`flex flex-col h-full bg-white border-l border-[#e7e5e4] overflow-hidden
      transition-all duration-200 ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#e7e5e4] bg-[#fafafa] flex-shrink-0">
        <h2 className="text-xs font-semibold text-[#57534e] uppercase tracking-wider">
          {filter === 'tasks' ? 'Task List' : 'Activity Log'}
        </h2>
        <span className="text-[10px] text-[#a8a29e] font-mono">
          {filter === 'tasks' ? todoList.length : logs.length}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-[#e7e5e4] flex-shrink-0 overflow-x-auto">
        {FILTERS.map(opt => {
          const count = opt.value === 'tasks'
            ? todoList.length
            : opt.value === 'all' ? logs.length : logs.filter(l => l.type === opt.value).length;
          const isError = opt.value === 'error' && errorCount > 0;
          return (
            <button
              key={opt.value}
              id={`log-filter-${opt.value}`}
              onClick={() => setFilter(opt.value)}
              className={`
                px-3 py-2 text-[11px] font-medium whitespace-nowrap flex items-center gap-1.5
                border-b-2 transition-colors duration-100
                ${filter === opt.value
                  ? 'border-[#2563eb] text-[#2563eb] bg-[#eff6ff]'
                  : 'border-transparent text-[#78716c] hover:text-[#1c1917] hover:bg-[#f5f5f4]'
                }
              `}
            >
              {opt.label}
              {count > 0 && (
                <span className={`text-[9px] px-1 py-px rounded font-semibold
                  ${isError ? 'bg-red-100 text-red-600' : 'bg-[#f5f5f4] text-[#78716c]'}
                `}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {filter === 'tasks' ? (
          <TodoListPanel todoList={todoList} />
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-8">
            <p className="text-sm text-[#a8a29e]">No activity yet</p>
            <p className="text-xs text-[#c4bfbb]">Tool calls and pipeline events will appear here</p>
          </div>
        ) : (
          <div className="divide-y divide-[#f5f5f4]">
            {filteredLogs.map((log, i) => (
              <LogEntry key={`${log.timestamp}-${i}`} log={log} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
