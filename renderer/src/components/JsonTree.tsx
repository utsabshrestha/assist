import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';

interface JsonTreeProps {
  data: unknown;
  depth?: number;
  maxDepth?: number;
  /** key name from parent, used for display */
  label?: string;
  isLast?: boolean;
}

function getValueType(val: unknown): string {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function getCountLabel(val: unknown): string {
  if (Array.isArray(val)) return `[${val.length}]`;
  if (val !== null && typeof val === 'object') {
    const count = Object.keys(val as object).length;
    return `{${count}}`;
  }
  return '';
}

/** Render a leaf scalar value with appropriate color */
function ScalarValue({ val }: { val: unknown }) {
  const type = getValueType(val);
  if (type === 'null') {
    return <span className="json-null">null</span>;
  }
  if (type === 'boolean') {
    return <span className="json-bool">{String(val)}</span>;
  }
  if (type === 'number') {
    return <span className="json-number">{String(val)}</span>;
  }
  if (type === 'string') {
    const str = val as string;
    // Long strings get ellipsis hint — the modal shows the full value
    const display = str.length > 120 ? str.slice(0, 120) + '…' : str;
    return <span className="json-string">"{display}"</span>;
  }
  return <span className="json-string">"{String(val)}"</span>;
}

export const JsonTree: React.FC<JsonTreeProps> = ({
  data,
  depth = 0,
  maxDepth = 2,
  label,
  isLast = true,
}) => {
  const [collapsed, setCollapsed] = useState(depth >= maxDepth);
  const type = getValueType(data);
  const isExpandable = type === 'object' || type === 'array';
  const indent = depth * 12;

  const labelEl = label !== undefined ? (
    <span className="json-key">"{label}"</span>
  ) : null;
  const colon = label !== undefined ? <span className="json-punct">: </span> : null;
  const comma = !isLast ? <span className="json-punct">,</span> : null;

  if (!isExpandable) {
    return (
      <div className="json-row" style={{ paddingLeft: indent }}>
        {labelEl}{colon}<ScalarValue val={data} />{comma}
      </div>
    );
  }

  const isArray = type === 'array';
  const entries = isArray
    ? (data as unknown[]).map((v, i) => ({ key: String(i), val: v }))
    : Object.entries(data as object).map(([k, v]) => ({ key: k, val: v }));
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';
  const countLabel = getCountLabel(data);

  return (
    <div>
      {/* Header row */}
      <div
        className="json-row json-collapsible"
        style={{ paddingLeft: indent }}
        onClick={() => setCollapsed(c => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setCollapsed(c => !c)}
      >
        <ChevronRight
          size={9}
          className={`json-chevron ${collapsed ? '' : 'rotate-90'}`}
        />
        {labelEl}{colon}
        <span className="json-punct">{openBracket}</span>
        {collapsed && (
          <span className="json-collapsed-hint">{countLabel}</span>
        )}
        {collapsed && <span className="json-punct">{closeBracket}</span>}
        {collapsed && comma}
      </div>

      {/* Children */}
      {!collapsed && (
        <>
          {entries.map((entry, i) => (
            <JsonTree
              key={entry.key}
              data={entry.val}
              depth={depth + 1}
              maxDepth={maxDepth}
              label={isArray ? undefined : entry.key}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="json-row" style={{ paddingLeft: indent }}>
            <span className="json-punct">{closeBracket}</span>{comma}
          </div>
        </>
      )}
    </div>
  );
};
