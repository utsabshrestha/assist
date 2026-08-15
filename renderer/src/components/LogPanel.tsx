import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentLog, TodoItem } from '../types/electron.js';
import { LogEntry } from './LogEntry.js';
import { LogGroup } from './LogGroup.js';
import { TodoListPanel } from './TodoListPanel.js';
import { useSmartScroll } from '../hooks/useSmartScroll.js';

type LogRow =
  | { kind: 'single'; log: AgentLog }
  | { kind: 'group'; name: string; entries: AgentLog[] };

/** Collapses consecutive same-name tool_result entries into one scrollable group, so a long
 * run of per-file progress (e.g. clustering embedding logs) doesn't bury pipeline/error events. */
function groupConsecutiveLogs(logs: AgentLog[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const log of logs) {
    const last = rows[rows.length - 1];
    if (log.type === 'tool_result' && log.name && last?.kind === 'group' && last.name === log.name) {
      last.entries.push(log);
    } else if (log.type === 'tool_result' && log.name) {
      rows.push({ kind: 'group', name: log.name, entries: [log] });
    } else {
      rows.push({ kind: 'single', log });
    }
  }
  return rows;
}

interface LogPanelProps {
  logs: AgentLog[];
  todoList: TodoItem[];
  isVisible: boolean;
}

const FILTERS = [
  { value: 'tasks',       label: 'Task List' },
  { value: 'all',         label: 'All'       },
  { value: 'tool_call',   label: 'Calls'     },
  { value: 'tool_result', label: 'Results'   },
  { value: 'pipeline',    label: 'Pipeline'  },
  { value: 'error',       label: 'Errors'    },
  { value: 'mcp',         label: 'MCP'       },
];

export const LogPanel: React.FC<LogPanelProps> = ({ logs, todoList, isVisible }) => {
  const [filter, setFilter] = useState<string>('tasks');
  const { scrollRef, bottomRef, isAtBottom, scrollToBottom } = useSmartScroll([logs, filter]);

  const filteredLogs = filter === 'all' ? logs : logs.filter(l => l.type === filter);
  const errorCount   = logs.filter(l => l.type === 'error').length;
  const rows         = groupConsecutiveLogs(filteredLogs);

  return (
    <div className={`log-panel ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>

      {/* Header */}
      <div className="log-panel-header">
        <h2 className="log-panel-title">
          {filter === 'tasks' ? 'Task List' : 'Activity Log'}
        </h2>
        <span className="log-panel-count">
          {filter === 'tasks' ? todoList.length : logs.length}
        </span>
      </div>

      {/* Tab bar */}
      <div className="log-tab-bar">
        {FILTERS.map(opt => {
          const count = opt.value === 'tasks'
            ? todoList.length
            : opt.value === 'all'
              ? logs.length
              : logs.filter(l => l.type === opt.value).length;
          const isErr = opt.value === 'error' && errorCount > 0;
          const isActive = filter === opt.value;
          return (
            <button
              key={opt.value}
              id={`log-filter-${opt.value}`}
              onClick={() => setFilter(opt.value)}
              className={`log-tab ${isActive ? 'log-tab-active' : 'log-tab-inactive'}`}
            >
              {opt.label}
              {count > 0 && (
                <span className={`log-tab-badge ${isErr ? 'log-tab-badge-error' : ''}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div ref={scrollRef} className="log-panel-content">
        {filter === 'tasks' ? (
          <TodoListPanel todoList={todoList} />
        ) : filteredLogs.length === 0 ? (
          <div className="log-empty-state">
            <p className="log-empty-primary">No activity yet</p>
            <p className="log-empty-secondary">Tool calls and pipeline events will appear here</p>
          </div>
        ) : (
          <div className="log-entries-list">
            {rows.map((row, i) =>
              row.kind === 'group' && row.entries.length > 1 ? (
                <LogGroup key={`group-${row.entries[0]!.timestamp}-${i}`} name={row.name} entries={row.entries} />
              ) : (
                <LogEntry
                  key={`${(row.kind === 'group' ? row.entries[0]! : row.log).timestamp}-${i}`}
                  log={row.kind === 'group' ? row.entries[0]! : row.log}
                />
              )
            )}
          </div>
        )}
        <div ref={bottomRef} />

        {/* Jump-to-bottom pill */}
        {filter !== 'tasks' && !isAtBottom && (
          <div className="sticky bottom-3 flex justify-center pointer-events-none">
            <button
              onClick={scrollToBottom}
              className="log-jump-btn pointer-events-auto"
            >
              <ChevronDown size={11} strokeWidth={2.5} />
              New logs
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
