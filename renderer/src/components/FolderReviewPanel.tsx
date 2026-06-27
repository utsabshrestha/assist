import React, { useState, useCallback, useRef, useEffect } from 'react';
import { FolderTree, ChevronRight, Check } from 'lucide-react';
import type { FolderReviewRequest } from '../types/electron.js';

interface FolderReviewPanelProps {
  request: FolderReviewRequest;
  onSubmit: (inputId: string, action: 'approve' | 'message', message?: string) => void;
}

export const FolderReviewPanel: React.FC<FolderReviewPanelProps> = ({ request, onSubmit }) => {
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

  const handleApprove = useCallback(() => {
    setSubmitted(true);
    onSubmit(request.inputId, 'approve');
  }, [request.inputId, onSubmit]);

  const handleSendMessage = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setSubmitted(true);
    setSubmittedMessage(trimmed);
    onSubmit(request.inputId, 'message', trimmed);
  }, [request.inputId, message, onSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const extLabel = request.extension.startsWith('.')
    ? request.extension.toUpperCase().slice(1)
    : request.extension.toUpperCase();

  return (
    <div
      className="folder-review-panel"
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
        <div
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #c2613d, #a8502f)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <FolderTree size={16} color="white" strokeWidth={2} />
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#57341f' }}>
              Proposed Folder Structure
            </span>
            <span
              style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                padding: '2px 7px', borderRadius: 99,
                background: 'linear-gradient(135deg, #c2613d, #a8502f)',
                color: 'white',
              }}
            >
              .{extLabel}
            </span>
          </div>
          <p style={{ fontSize: 12, color: '#8a5a3d', margin: '2px 0 0' }}>
            Review the categories below before finalizing.
          </p>
        </div>
      </div>

      {/* Folder table — stays visible pre-submit, and re-expandable after */}
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
          <div
            style={{
              display: 'grid', gridTemplateColumns: '160px 1fr',
              padding: '6px 12px',
              background: '#f3ddcd',
              borderBottom: '1px solid #e8cab8',
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 700, color: '#8a5a3d', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Category
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#8a5a3d', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Folder Path
            </span>
          </div>

          {request.folders.map((entry, i) => (
            <div
              key={`${entry.category}-${i}`}
              style={{
                display: 'grid', gridTemplateColumns: '160px 1fr',
                padding: '8px 12px',
                borderBottom: i < request.folders.length - 1 ? '1px solid #f3ddcd' : 'none',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 7, height: 7, borderRadius: '50%',
                    background: 'linear-gradient(135deg, #c2613d, #a8502f)',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#57341f', wordBreak: 'break-word' }}>
                  {entry.category}
                </span>
              </div>

              <span
                title={entry.folder}
                style={{
                  fontSize: 11, color: '#8a5a3d',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  paddingLeft: 8,
                }}
              >
                {entry.folder}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {!submitted && (
        <div>
          {mode === 'idle' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                id={`approve-btn-${request.inputId}`}
                onClick={handleApprove}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: 'var(--color-accent)',
                  color: 'white', fontSize: 13, fontWeight: 600,
                  boxShadow: '0 2px 8px rgba(194,97,61,0.3)',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
              >
                <Check size={14} strokeWidth={2.5} />
                Approve
              </button>

              <button
                id={`changes-btn-${request.inputId}`}
                onClick={() => setMode('changes')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
                  background: 'white', color: '#8a5a3d',
                  border: '1px solid #e8cab8', fontSize: 13, fontWeight: 500,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fdf1ec')}
                onMouseLeave={e => (e.currentTarget.style.background = 'white')}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Request Changes
              </button>
            </div>
          )}

          {mode === 'changes' && (
            <div>
              <p style={{ fontSize: 12, color: '#8a5a3d', marginBottom: 8, fontWeight: 500 }}>
                Describe what you'd like to change (e.g. "merge invoices and billing", "rename contracts to legal"):
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <textarea
                  ref={inputRef}
                  id={`changes-input-${request.inputId}`}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={2}
                  placeholder="e.g. merge invoices and billing into one folder…"
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
                  id={`send-changes-btn-${request.inputId}`}
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
            {submittedMessage ? `— "${submittedMessage}"` : `— ${request.folders.length} folder(s)`}
          </span>
        </button>
      )}
    </div>
  );
};
