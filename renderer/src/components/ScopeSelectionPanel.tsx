import React, { useState, useCallback, useRef, useEffect } from 'react';
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
        background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
        border: '1px solid #bae6fd',
        borderRadius: '12px',
        padding: '16px',
        marginTop: '4px',
        maxWidth: '100%',
        boxShadow: '0 1px 4px rgba(14, 165, 233, 0.08)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <div
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </div>

        <div>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0c4a6e' }}>
            What would you like to organize?
          </span>
          <p style={{ fontSize: 12, color: '#0369a1', margin: '2px 0 0' }}>
            {request.totalFileCount} files found ({request.totalFileSize}). Pick the categories to organize.
          </p>
        </div>
      </div>

      {/* Category checklist */}
      <div
        style={{
          background: 'rgba(255,255,255,0.7)',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid #e0f2fe',
          marginBottom: 14,
        }}
      >
        {categoryKeys.map((key, i) => (
          <label
            key={key}
            htmlFor={`scope-cb-${request.inputId}-${key}`}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px', cursor: 'pointer',
              borderBottom: i < categoryKeys.length - 1 ? '1px solid #e0f2fe' : 'none',
            }}
          >
            <input
              id={`scope-cb-${request.inputId}-${key}`}
              type="checkbox"
              checked={!!checked[key]}
              onChange={() => toggleCategory(key)}
              disabled={submitted}
              style={{ marginTop: 2, width: 15, height: 15, cursor: 'pointer', accentColor: '#0ea5e9' }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0c4a6e' }}>
                {CATEGORY_LABELS[key]}
              </div>
              <div
                style={{
                  fontSize: 11, color: '#475569', marginTop: 2,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {request.categories[key].join(', ')}
              </div>
            </div>
          </label>
        ))}
      </div>

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
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 18px', borderRadius: 8, border: 'none',
                  cursor: anyChecked ? 'pointer' : 'not-allowed',
                  background: anyChecked ? 'linear-gradient(135deg, #0ea5e9, #6366f1)' : '#e0f2fe',
                  color: anyChecked ? 'white' : '#94a3b8', fontSize: 13, fontWeight: 600,
                  boxShadow: anyChecked ? '0 2px 8px rgba(14,165,233,0.3)' : 'none',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => { if (anyChecked) e.currentTarget.style.opacity = '0.88'; }}
                onMouseLeave={e => { if (anyChecked) e.currentTarget.style.opacity = '1'; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Continue
              </button>

              <button
                id={`scope-changes-btn-${request.inputId}`}
                onClick={() => setMode('changes')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
                  background: 'white', color: '#0369a1',
                  border: '1px solid #bae6fd', fontSize: 13, fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f0f9ff')}
                onMouseLeave={e => (e.currentTarget.style.background = 'white')}
              >
                Something else
              </button>
            </div>
          )}

          {mode === 'changes' && (
            <div>
              <p style={{ fontSize: 12, color: '#0369a1', marginBottom: 8, fontWeight: 500 }}>
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
                    border: '1px solid #bae6fd', fontSize: 13, color: '#0c4a6e',
                    background: 'white', outline: 'none', fontFamily: 'inherit',
                    boxShadow: 'inset 0 1px 3px rgba(14,165,233,0.08)',
                  }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#0ea5e9')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#bae6fd')}
                />
                <button
                  id={`scope-send-changes-btn-${request.inputId}`}
                  onClick={handleSendMessage}
                  disabled={!message.trim()}
                  style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    cursor: message.trim() ? 'pointer' : 'not-allowed',
                    background: message.trim() ? 'linear-gradient(135deg, #0ea5e9, #6366f1)' : '#e0f2fe',
                    color: message.trim() ? 'white' : '#94a3b8',
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
                  color: '#94a3b8', fontSize: 11, cursor: 'pointer', padding: 0,
                }}
              >
                ← Back
              </button>
            </div>
          )}
        </div>
      )}

      {submitted && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(255,255,255,0.6)', border: '1px solid #bae6fd',
            fontSize: 12, color: '#0369a1',
          }}
        >
          <div
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
              flexShrink: 0,
            }}
          />
          Response sent — waiting for agent…
        </div>
      )}
    </div>
  );
};
