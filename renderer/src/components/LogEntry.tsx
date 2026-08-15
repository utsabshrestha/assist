import React, { useState, useCallback } from 'react';
import { Maximize2 } from 'lucide-react';
import type { AgentLog } from '../types/electron.js';
import { JsonTree } from './JsonTree.js';
import { JsonModal } from './JsonModal.js';

interface LogEntryProps {
  log: AgentLog;
}

/** Config per log type — icon, label, accent color CSS var */
const LOG_CONFIG: Record<string, {
  label: string;
  icon: string;
  accentClass: string;
  badgeClass: string;
}> = {
  tool_call: {
    label: 'Tool Call',
    icon: '⚡',
    accentClass: 'log-accent-call',
    badgeClass: 'log-badge-call',
  },
  tool_result: {
    label: 'Result',
    icon: '✔',
    accentClass: 'log-accent-result',
    badgeClass: 'log-badge-result',
  },
  pipeline: {
    label: 'Pipeline',
    icon: '◈',
    accentClass: 'log-accent-pipeline',
    badgeClass: 'log-badge-pipeline',
  },
  error: {
    label: 'Error',
    icon: '✕',
    accentClass: 'log-accent-error',
    badgeClass: 'log-badge-error',
  },
  info: {
    label: 'Info',
    icon: 'ℹ',
    accentClass: 'log-accent-info',
    badgeClass: 'log-badge-info',
  },
  mcp: {
    label: 'MCP',
    icon: '⬡',
    accentClass: 'log-accent-mcp',
    badgeClass: 'log-badge-mcp',
  },
};

/** Try to parse JSON from a string. Returns parsed object or null. */
function tryParseJson(content: string): unknown | null {
  const trimmed = content.trim();
  // Must start with { or [ to be plausible JSON — avoids parsing plain strings
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Extract the JSON portion from a content string that may have a prefix like "ToolName({...})" */
function extractJson(content: string): { prefix: string; json: unknown } | null {
  // Case 1: entire content is JSON
  const direct = tryParseJson(content);
  if (direct !== null) return { prefix: '', json: direct };

  // Case 2: content has a prefix then JSON object/array e.g. "ToolName({"key":"val"})"
  const match = content.match(/^([^{[]*?)(\{[\s\S]*\}|\[[\s\S]*\])$/);
  if (match) {
    const prefix = match[1]!.trim();
    const jsonStr = match[2]!;
    const parsed = tryParseJson(jsonStr);
    if (parsed !== null) return { prefix, json: parsed };
  }

  return null;
}

export const LogEntry: React.FC<LogEntryProps> = ({ log }) => {
  const [expanded, setExpanded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const config = LOG_CONFIG[log.type] ?? LOG_CONFIG['info']!;

  const time = new Date(log.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  // Try JSON parsing
  const jsonResult = extractJson(log.content);
  const isJson = jsonResult !== null;

  // For non-JSON, truncation logic
  const TRUNCATE = 180;
  const isLong = !isJson && log.content.length > TRUNCATE;
  const displayText = !isJson && isLong && !expanded
    ? log.content.slice(0, TRUNCATE) + '…'
    : log.content;

  const handleOpenModal = useCallback(() => setModalOpen(true), []);
  const handleCloseModal = useCallback(() => setModalOpen(false), []);

  return (
    <>
      <div className={`log-entry ${config.accentClass}`}>
        {/* Row 1: badge + name + time */}
        <div className="log-entry-header">
          <span className={`log-badge ${config.badgeClass}`}>
            <span className="log-badge-icon">{config.icon}</span>
            {config.label}
          </span>

          {log.name && (
            <code className="log-name-chip">{log.name}</code>
          )}

          <span className="log-timestamp">{time}</span>

          {/* Expand to full modal for JSON */}
          {isJson && (
            <button
              className="log-expand-btn"
              onClick={handleOpenModal}
              title="Open full JSON viewer"
            >
              <Maximize2 size={10} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Row 2: content */}
        <div className="log-entry-body">
          {isJson ? (
            <>
              {/* Show prefix text (e.g. "ToolName →") above tree if present */}
              {jsonResult.prefix && (
                <p className="log-prefix-text">{jsonResult.prefix}</p>
              )}
              {/* Inline collapsible tree, capped height */}
              <div className="log-json-tree selectable">
                <JsonTree data={jsonResult.json} depth={0} maxDepth={2} />
              </div>
            </>
          ) : (
            <p
              className="log-plain-text selectable"
              onClick={() => isLong && setExpanded(e => !e)}
            >
              {displayText}
              {isLong && (
                <button
                  className="log-expand-text-btn"
                  onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
                >
                  {expanded ? 'less' : 'more'}
                </button>
              )}
            </p>
          )}
        </div>
      </div>

      {modalOpen && isJson && (
        <JsonModal
          data={jsonResult.json}
          title={log.name ?? config.label}
          onClose={handleCloseModal}
        />
      )}
    </>
  );
};
