import React, { useEffect, useCallback } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { JsonTree } from './JsonTree.js';

interface JsonModalProps {
  data: unknown;
  title?: string;
  onClose: () => void;
}

export const JsonModal: React.FC<JsonModalProps> = ({ data, title, onClose }) => {
  const [copied, setCopied] = React.useState(false);

  const handleClose = useCallback(() => onClose(), [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  const handleCopy = useCallback(() => {
    const pretty = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(pretty).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [data]);

  return (
    <div
      className="json-modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'JSON viewer'}
    >
      <div className="json-modal-panel">
        {/* Modal header */}
        <div className="json-modal-header">
          <div className="json-modal-title">
            <span className="json-modal-dot" />
            {title ?? 'JSON Payload'}
          </div>
          <div className="json-modal-actions">
            <button
              onClick={handleCopy}
              className="json-modal-btn"
              title="Copy as JSON"
            >
              {copied
                ? <Check size={13} strokeWidth={2.5} className="text-emerald-400" />
                : <Copy size={13} strokeWidth={2} />
              }
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
            <button
              onClick={handleClose}
              className="json-modal-btn json-modal-close"
              title="Close (Esc)"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Scrollable JSON body */}
        <div className="json-modal-body selectable">
          <JsonTree data={data} depth={0} maxDepth={99} />
        </div>
      </div>
    </div>
  );
};
