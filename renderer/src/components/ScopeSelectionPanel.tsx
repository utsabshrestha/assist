import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, Check, FileText, Image, Package } from 'lucide-react';
import type { ScopeSelectionRequest, CategorySummary } from '../types/electron.js';

interface ScopeSelectionPanelProps {
  request: ScopeSelectionRequest;
  onSubmit: (inputId: string, action: 'submit' | 'message', selected?: CategorySummary, message?: string) => void;
}

type CategoryKey = keyof CategorySummary;

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  documents: 'Documents',
  images: 'Images',
  'non-documents': 'Non-Documents',
};

const CATEGORY_ICON_COMPONENTS: Record<CategoryKey, React.ReactElement> = {
  documents: <FileText size={14} strokeWidth={2} color="#c2613d" />,
  images: <Image size={14} strokeWidth={2} color="#c2613d" />,
  'non-documents': <Package size={14} strokeWidth={2} color="#c2613d" />,
};

/** Build initial per-extension checked state — all true by default. */
function buildInitialExtChecked(
  categories: CategorySummary,
  categoryKeys: CategoryKey[]
): Record<string, boolean> {
  const initial: Record<string, boolean> = {};
  categoryKeys.forEach(key => {
    categories[key].forEach(ext => {
      initial[ext] = true;
    });
  });
  return initial;
}

function formatCount(n: number): string {
  return n === 1 ? '1 file' : `${n} files`;
}

export const ScopeSelectionPanel: React.FC<ScopeSelectionPanelProps> = ({ request, onSubmit }) => {
  const categoryKeys = (Object.keys(request.categories) as CategoryKey[]).filter(
    key => request.categories[key].length > 0
  );

  // Per-extension checked map
  const [extChecked, setExtChecked] = useState<Record<string, boolean>>(() =>
    buildInitialExtChecked(request.categories, categoryKeys)
  );

  // Track expanded category accordion state
  const [expanded, setExpanded] = useState<Record<CategoryKey, boolean>>(() => {
    const init = {} as Record<CategoryKey, boolean>;
    categoryKeys.forEach(k => { init[k] = false; });
    return init;
  });

  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'idle' | 'changes'>('idle');
  const [submitted, setSubmitted] = useState(false);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [resultCollapsed, setResultCollapsed] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode === 'changes') {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [mode]);

  // ── Derived helpers ────────────────────────────────────────────────────────

  const getCategoryState = useCallback((key: CategoryKey): 'all' | 'none' | 'partial' => {
    const exts = request.categories[key];
    const checkedCount = exts.filter(ext => extChecked[ext]).length;
    if (checkedCount === 0) return 'none';
    if (checkedCount === exts.length) return 'all';
    return 'partial';
  }, [extChecked, request.categories]);

  const anyChecked = categoryKeys.some(key => getCategoryState(key) !== 'none');

  const approvedLabels = categoryKeys
    .filter(key => getCategoryState(key) !== 'none')
    .map(key => CATEGORY_LABELS[key]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const toggleExtension = useCallback((ext: string) => {
    setExtChecked(prev => ({ ...prev, [ext]: !prev[ext] }));
  }, []);

  const toggleCategory = useCallback((key: CategoryKey) => {
    const state = getCategoryState(key);
    const newVal = state === 'all' ? false : true; // partial/none → all; all → none
    setExtChecked(prev => {
      const next = { ...prev };
      request.categories[key].forEach(ext => { next[ext] = newVal; });
      return next;
    });
  }, [getCategoryState, request.categories]);

  const toggleExpanded = useCallback((key: CategoryKey) => {
    if (submitted) return;
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  }, [submitted]);

  const handleContinue = useCallback(() => {
    if (!anyChecked) return;
    const selected: CategorySummary = { documents: [], images: [], 'non-documents': [] };
    categoryKeys.forEach(key => {
      selected[key] = request.categories[key].filter(ext => extChecked[ext]);
    });
    setSubmitted(true);
    onSubmit(request.inputId, 'submit', selected);
  }, [anyChecked, categoryKeys, extChecked, request, onSubmit]);

  const handleSendMessage = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setSubmitted(true);
    setSubmittedMessage(trimmed);
    onSubmit(request.inputId, 'message', undefined, trimmed);
  }, [request.inputId, message, onSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // ── Sub-components (inline) ────────────────────────────────────────────────

  const renderCategoryCheckbox = (key: CategoryKey, state: 'all' | 'none' | 'partial') => {
    const isIndeterminate = state === 'partial';
    const isChecked = state === 'all';
    return (
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: 4, flexShrink: 0,
          border: isChecked || isIndeterminate ? '2px solid #c2613d' : '2px solid #d4a896',
          background: isChecked ? '#c2613d' : isIndeterminate ? '#f5d5c8' : 'white',
          cursor: submitted ? 'default' : 'pointer',
          transition: 'all 0.15s',
          position: 'relative',
        }}
        onClick={e => { e.stopPropagation(); if (!submitted) toggleCategory(key); }}
      >
        {isChecked && <Check size={10} strokeWidth={3} color="white" />}
        {isIndeterminate && (
          <span style={{
            display: 'block', width: 8, height: 2,
            background: '#c2613d', borderRadius: 1,
          }} />
        )}
      </span>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="scope-selection-panel"
      style={{
        background: 'linear-gradient(135deg, #fdf1ec 0%, #f9f1ea 100%)',
        border: '1px solid #e8cab8',
        borderRadius: '12px',
        padding: '16px',
        marginTop: '4px',
        maxWidth: '100%',
        boxShadow: '0 1px 4px rgba(194, 97, 61, 0.08)',
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: '12px' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#57341f' }}>
          What would you like to organize?
        </span>
        <p style={{ fontSize: 12, color: '#8a5a3d', margin: '2px 0 0' }}>
          {request.totalFileCount} files found ({request.totalFileSize}). Choose the file types to organize.
        </p>
      </div>

      {/* Category + Extension checklist */}
      {(!submitted || !resultCollapsed) && (
        <div
          style={{
            background: 'rgba(255,255,255,0.7)',
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid #f3ddcd',
            marginBottom: 14,
          }}
        >
          {categoryKeys.map((key, i) => {
            const catState = getCategoryState(key);
            const exts = request.categories[key];
            const isExpanded = expanded[key];
            const totalInCat = exts.reduce((sum, ext) => sum + (request.fileCountByExtension[ext] ?? 0), 0);
            const selectedInCat = exts.filter(ext => extChecked[ext]).reduce(
              (sum, ext) => sum + (request.fileCountByExtension[ext] ?? 0), 0
            );
            const isLast = i === categoryKeys.length - 1;

            return (
              <div
                key={key}
                style={{
                  borderBottom: !isLast ? '1px solid #f3ddcd' : 'none',
                }}
              >
                {/* Category row */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 12px',
                    cursor: submitted ? 'default' : 'pointer',
                    background: catState !== 'none' ? 'rgba(194, 97, 61, 0.04)' : 'transparent',
                    transition: 'background 0.15s',
                    userSelect: 'none',
                  }}
                  onClick={() => toggleExpanded(key)}
                >
                  {renderCategoryCheckbox(key, catState)}

                  <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{CATEGORY_ICON_COMPONENTS[key]}</span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 600, color: '#57341f',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      {CATEGORY_LABELS[key]}
                      {/* File count badge */}
                      <span style={{
                        fontSize: 10, fontWeight: 500,
                        background: catState !== 'none' ? '#f5d5c8' : '#f0e8e3',
                        color: catState !== 'none' ? '#c2613d' : '#a07060',
                        borderRadius: 10, padding: '1px 7px',
                        transition: 'all 0.15s',
                      }}>
                        {catState === 'partial'
                          ? `${selectedInCat} / ${totalInCat} files`
                          : formatCount(totalInCat)
                        }
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#a07060', marginTop: 1 }}>
                      {exts.length} extension{exts.length !== 1 ? 's' : ''}
                    </div>
                  </div>

                  {/* Expand chevron */}
                  {!submitted && (
                    <ChevronRight
                      size={13}
                      strokeWidth={2.5}
                      color="#c2a090"
                      style={{
                        flexShrink: 0,
                        transition: 'transform 0.2s',
                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                      }}
                    />
                  )}
                </div>

                {/* Extension rows */}
                {isExpanded && (
                  <div style={{
                    background: 'rgba(255,252,250,0.9)',
                    borderTop: '1px solid #f3ddcd',
                  }}>
                    {exts.map((ext, ei) => {
                      const count = request.fileCountByExtension[ext] ?? 0;
                      const isExtChecked = extChecked[ext];
                      const isLastExt = ei === exts.length - 1;
                      return (
                        <label
                          key={ext}
                          htmlFor={`scope-ext-${request.inputId}-${ext}`}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '7px 12px 7px 36px',
                            cursor: submitted ? 'default' : 'pointer',
                            borderBottom: !isLastExt ? '1px solid #f8ece5' : 'none',
                            background: isExtChecked ? 'rgba(194,97,61,0.03)' : 'transparent',
                            transition: 'background 0.12s',
                          }}
                        >
                          {/* Custom square checkbox */}
                          <input
                            id={`scope-ext-${request.inputId}-${ext}`}
                            type="checkbox"
                            checked={isExtChecked}
                            onChange={() => toggleExtension(ext)}
                            disabled={submitted}
                            style={{ display: 'none' }}
                          />
                          <span
                            style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                              border: isExtChecked ? '2px solid #c2613d' : '2px solid #d4a896',
                              background: isExtChecked ? '#c2613d' : 'white',
                              transition: 'all 0.12s',
                            }}
                          >
                            {isExtChecked && <Check size={8} strokeWidth={3} color="white" />}
                          </span>

                          {/* Extension pill */}
                          <span style={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: 11, fontWeight: 600,
                            background: isExtChecked ? '#fde8df' : '#f5ede8',
                            color: isExtChecked ? '#b84e2a' : '#a07060',
                            borderRadius: 5, padding: '2px 7px',
                            letterSpacing: '0.01em',
                            transition: 'all 0.12s',
                            whiteSpace: 'nowrap',
                          }}>
                            {ext}
                          </span>

                          {/* Count bar + label */}
                          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{
                              flex: 1, height: 4, borderRadius: 2,
                              background: '#f3ddcd', overflow: 'hidden',
                            }}>
                              <div style={{
                                height: '100%',
                                width: `${Math.min(100, (count / (request.totalFileCount || 1)) * 100)}%`,
                                background: isExtChecked
                                  ? 'linear-gradient(90deg, #c2613d, #e88a5f)'
                                  : '#d4a896',
                                borderRadius: 2,
                                transition: 'all 0.2s',
                              }} />
                            </div>
                            <span style={{
                              fontSize: 11, color: isExtChecked ? '#8a5a3d' : '#b89178',
                              whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                              minWidth: 42, textAlign: 'right',
                              transition: 'color 0.12s',
                            }}>
                              {formatCount(count)}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Actions */}
      {!submitted && (
        <div>
          {mode === 'idle' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                id={`continue-btn-${request.inputId}`}
                onClick={handleContinue}
                disabled={!anyChecked}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px', borderRadius: 7, border: 'none',
                  cursor: anyChecked ? 'pointer' : 'not-allowed',
                  background: anyChecked ? 'var(--color-accent)' : '#f3ddcd',
                  color: anyChecked ? 'white' : '#b89178', fontSize: 12, fontWeight: 600,
                  boxShadow: anyChecked ? '0 2px 8px rgba(194,97,61,0.3)' : 'none',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => { if (anyChecked) e.currentTarget.style.opacity = '0.88'; }}
                onMouseLeave={e => { if (anyChecked) e.currentTarget.style.opacity = '1'; }}
              >
                <Check size={12} strokeWidth={2.5} />
                Continue
              </button>

              <button
                id={`scope-changes-btn-${request.inputId}`}
                onClick={() => setMode('changes')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                  background: 'white', color: '#8a5a3d',
                  border: '1px solid #e8cab8', fontSize: 12, fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fdf1ec')}
                onMouseLeave={e => (e.currentTarget.style.background = 'white')}
              >
                Something else
              </button>
            </div>
          )}

          {mode === 'changes' && (
            <div>
              <p style={{ fontSize: 12, color: '#8a5a3d', marginBottom: 8, fontWeight: 500 }}>
                Tell me what you'd like instead (e.g. "also include .epub files"):
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  ref={inputRef}
                  id={`scope-changes-input-${request.inputId}`}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={2}
                  placeholder="e.g. also include .epub files…"
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: 8, resize: 'none',
                    border: '1px solid #e8cab8', fontSize: 13, color: '#57341f',
                    background: 'white', outline: 'none', fontFamily: 'inherit',
                    boxShadow: 'inset 0 1px 3px rgba(194,97,61,0.08)',
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#c2613d')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#e8cab8')}
                />
                <button
                  id={`scope-send-changes-btn-${request.inputId}`}
                  onClick={handleSendMessage}
                  disabled={!message.trim()}
                  style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    cursor: message.trim() ? 'pointer' : 'not-allowed',
                    background: message.trim() ? 'var(--color-accent)' : '#f3ddcd',
                    color: message.trim() ? 'white' : '#b89178',
                    fontSize: 13, fontWeight: 600, flexShrink: 0, height: 38,
                    transition: 'all 0.15s',
                  }}
                >
                  Send
                </button>
              </div>
              <button
                onClick={() => { setMode('idle'); setMessage(''); }}
                style={{
                  marginTop: 6, background: 'none', border: 'none',
                  color: '#b89178', fontSize: 11, cursor: 'pointer', padding: 0,
                }}
              >
                ← Back
              </button>
            </div>
          )}
        </div>
      )}

      {submitted && (
        <button
          onClick={() => setResultCollapsed(c => !c)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
            padding: '8px 12px', borderRadius: 8, border: '1px solid #e8cab8',
            background: 'rgba(255,255,255,0.6)', cursor: 'pointer',
            fontSize: 12, color: '#8a5a3d',
          }}
        >
          <ChevronRight
            size={12}
            strokeWidth={2.5}
            style={{ flexShrink: 0, transition: 'transform 0.15s', transform: resultCollapsed ? 'none' : 'rotate(90deg)' }}
          />
          <Check size={13} strokeWidth={2.5} color="#15803d" style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 500, color: '#57341f' }}>
            {submittedMessage ? 'Sent a message' : 'Approved'}
          </span>
          <span>
            {submittedMessage ? `— "${submittedMessage}"` : `— ${approvedLabels.join(' · ')}`}
          </span>
        </button>
      )}
    </div>
  );
};
