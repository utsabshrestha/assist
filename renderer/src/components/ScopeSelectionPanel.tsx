import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, Check } from 'lucide-react';
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

export const ScopeSelectionPanel: React.FC<ScopeSelectionPanelProps> = ({ request, onSubmit }) => {
  const categoryKeys = (Object.keys(request.categories) as CategoryKey[]).filter(
    key => request.categories[key].length > 0
  );

  const [checked, setChecked] = useState<Record<CategoryKey, boolean>>(() => {
    const initial = {} as Record<CategoryKey, boolean>;
    categoryKeys.forEach(key => { initial[key] = true; });
    return initial;
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

  const toggleCategory = useCallback((key: CategoryKey) => {
    setChecked(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const anyChecked = categoryKeys.some(key => checked[key]);
  const approvedLabels = categoryKeys.filter(key => checked[key]).map(key => CATEGORY_LABELS[key]);

  const handleContinue = useCallback(() => {
    if (!anyChecked) return;
    const selected: CategorySummary = { documents: [], images: [], "non-documents": [] };
    categoryKeys.forEach(key => {
      if (checked[key]) selected[key] = request.categories[key];
    });
    setSubmitted(true);
    onSubmit(request.inputId, 'submit', selected);
  }, [anyChecked, categoryKeys, checked, request, onSubmit]);

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
          {request.totalFileCount} files found ({request.totalFileSize}). Pick the categories to organize.
        </p>
      </div>

      {/* Category checklist — stays visible pre-submit, and re-expandable after */}
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
          {categoryKeys.map((key, i) => (
            <label
              key={key}
              htmlFor={`scope-cb-${request.inputId}-${key}`}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px', cursor: submitted ? 'default' : 'pointer',
                borderBottom: i < categoryKeys.length - 1 ? '1px solid #f3ddcd' : 'none',
              }}
            >
              <input
                id={`scope-cb-${request.inputId}-${key}`}
                type="checkbox"
                checked={!!checked[key]}
                onChange={() => toggleCategory(key)}
                disabled={submitted}
                style={{ marginTop: 2, width: 12, height: 12, cursor: submitted ? 'default' : 'pointer', accentColor: '#c2613d' }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#57341f' }}>
                  {CATEGORY_LABELS[key]}
                </div>
                <div
                  style={{
                    fontSize: 11, color: '#8a5a3d', marginTop: 2,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                >
                  {request.categories[key].join(', ')}
                </div>
              </div>
            </label>
          ))}
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
