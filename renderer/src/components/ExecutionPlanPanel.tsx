// NOTE: unlike the other structured panels (ScopeSelectionPanel, FolderReviewPanel), this
// component uses Tailwind classes instead of inline `style` objects. Those panels are simple,
// mostly-static cards; this one has many more conditional/dynamic states (drag-over highlight,
// inline-edit mode, disabled-delete) where Tailwind's conditional className composition is far
// less verbose. This is a deliberate, scoped divergence — not an inconsistency.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronRight, Check, Pencil, Trash2, Plus, X } from 'lucide-react';
import type { ExecutionPlanRequest, ExecutionPlanFileAssignment, PlanScope, PlanFolderEntry } from '../types/electron.js';

interface ExecutionPlanPanelProps {
  request: ExecutionPlanRequest;
  onSubmit: (inputId: string, action: 'approve' | 'message', assignments?: ExecutionPlanFileAssignment[], message?: string) => void;
}

interface EditableFile {
  fileName: string;
  fileSize: number;
}
interface EditableFolder {
  id: string;
  category: string;
  files: EditableFile[];
}
interface EditableExtensionGroup {
  extension: string;
  folders: EditableFolder[];
}
interface EditableScopeGroup {
  scope: PlanScope;
  extensionGroups?: EditableExtensionGroup[] | undefined;
  folders?: EditableFolder[] | undefined;
}

let folderIdCounter = 0;
const nextFolderId = () => `folder_${++folderIdCounter}`;

function toEditableFolder(entry: PlanFolderEntry): EditableFolder {
  return {
    id: nextFolderId(),
    category: entry.category,
    files: entry.files.map(f => ({ fileName: f.fileName, fileSize: f.fileSize })),
  };
}

function toEditableTree(scopes: ExecutionPlanRequest['scopes']): EditableScopeGroup[] {
  return scopes.map(s => {
    const result: EditableScopeGroup = { scope: s.scope };
    if (s.extensionGroups) {
      result.extensionGroups = s.extensionGroups.map(eg => ({
        extension: eg.extension,
        folders: eg.folders.map(toEditableFolder),
      }));
    }
    if (s.folders) {
      result.folders = s.folders.map(toEditableFolder);
    }
    return result;
  });
}

const SCOPE_LABELS: Record<PlanScope, string> = {
  documents: 'Documents',
  images: 'Images',
  'non-documents': 'Other Files',
};

function formatSize(kb: number): string {
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

interface DragPayload {
  fileName: string;
  sourceFolderId: string;
}

export const ExecutionPlanPanel: React.FC<ExecutionPlanPanelProps> = ({ request, onSubmit }) => {
  const [tree, setTree] = useState<EditableScopeGroup[]>(() => toEditableTree(request.scopes));
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'idle' | 'changes'>('idle');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  const allFolders = useMemo(() => {
    const result: { folder: EditableFolder; scope: PlanScope; extension?: string }[] = [];
    for (const sg of tree) {
      if (sg.extensionGroups) {
        for (const eg of sg.extensionGroups) {
          for (const folder of eg.folders) {
            result.push({ folder, scope: sg.scope, extension: eg.extension });
          }
        }
      }
      if (sg.folders) {
        for (const folder of sg.folders) {
          result.push({ folder, scope: sg.scope });
        }
      }
    }
    return result;
  }, [tree]);

  const moveFile = useCallback((fileName: string, sourceFolderId: string, targetFolderId: string) => {
    if (sourceFolderId === targetFolderId) return;
    setTree(prev => {
      let moved: EditableFile | undefined;
      const withoutFile = prev.map(sg => ({
        ...sg,
        extensionGroups: sg.extensionGroups?.map(eg => ({
          ...eg,
          folders: eg.folders.map(f => {
            if (f.id !== sourceFolderId) return f;
            const idx = f.files.findIndex(file => file.fileName === fileName);
            if (idx === -1) return f;
            moved = f.files[idx];
            return { ...f, files: f.files.filter((_, i) => i !== idx) };
          }),
        })),
        folders: sg.folders?.map(f => {
          if (f.id !== sourceFolderId) return f;
          const idx = f.files.findIndex(file => file.fileName === fileName);
          if (idx === -1) return f;
          moved = f.files[idx];
          return { ...f, files: f.files.filter((_, i) => i !== idx) };
        }),
      }));

      if (!moved) return prev;
      const movedFile = moved;

      return withoutFile.map(sg => ({
        ...sg,
        extensionGroups: sg.extensionGroups?.map(eg => ({
          ...eg,
          folders: eg.folders.map(f => f.id === targetFolderId ? { ...f, files: [...f.files, movedFile] } : f),
        })),
        folders: sg.folders?.map(f => f.id === targetFolderId ? { ...f, files: [...f.files, movedFile] } : f),
      }));
    });
  }, []);

  const renameFolder = useCallback((folderId: string, newName: string) => {
    setTree(prev => prev.map(sg => ({
      ...sg,
      extensionGroups: sg.extensionGroups?.map(eg => ({
        ...eg,
        folders: eg.folders.map(f => f.id === folderId ? { ...f, category: newName } : f),
      })),
      folders: sg.folders?.map(f => f.id === folderId ? { ...f, category: newName } : f),
    })));
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setTree(prev => prev.map(sg => ({
      ...sg,
      extensionGroups: sg.extensionGroups?.map(eg => ({
        ...eg,
        folders: eg.folders.filter(f => f.id !== folderId),
      })),
      folders: sg.folders?.filter(f => f.id !== folderId),
    })));
  }, []);

  const createFolder = useCallback((scope: PlanScope, extension: string | undefined, name: string) => {
    const newFolder: EditableFolder = { id: nextFolderId(), category: name, files: [] };
    setTree(prev => prev.map(sg => {
      if (sg.scope !== scope) return sg;
      if (extension !== undefined && sg.extensionGroups) {
        return {
          ...sg,
          extensionGroups: sg.extensionGroups.map(eg =>
            eg.extension === extension ? { ...eg, folders: [...eg.folders, newFolder] } : eg
          ),
        };
      }
      if (sg.folders) {
        return { ...sg, folders: [...sg.folders, newFolder] };
      }
      return sg;
    }));
  }, []);

  const validate = useCallback((): string | null => {
    for (const { folder } of allFolders) {
      if (folder.files.length === 0) continue;
      if (!folder.category.trim()) return 'A folder has an empty name. Please name every folder that still has files in it.';
    }
    // duplicate-name check, scoped per extension group (documents) or per scope (images/non-documents)
    const seen = new Map<string, Set<string>>();
    for (const sg of tree) {
      if (sg.extensionGroups) {
        for (const eg of sg.extensionGroups) {
          const bucketKey = `documents:${eg.extension}`;
          const names = seen.get(bucketKey) ?? new Set<string>();
          for (const folder of eg.folders) {
            if (folder.files.length === 0) continue;
            const norm = folder.category.trim().toLowerCase();
            if (names.has(norm)) return `Two folders named "${folder.category}" exist for ${eg.extension} files. Please rename one.`;
            names.add(norm);
          }
          seen.set(bucketKey, names);
        }
      }
      if (sg.folders) {
        const bucketKey = `scope:${sg.scope}`;
        const names = seen.get(bucketKey) ?? new Set<string>();
        for (const folder of sg.folders) {
          if (folder.files.length === 0) continue;
          const norm = folder.category.trim().toLowerCase();
          if (names.has(norm)) return `Two folders named "${folder.category}" exist. Please rename one.`;
          names.add(norm);
        }
        seen.set(bucketKey, names);
      }
    }
    return null;
  }, [tree, allFolders]);

  const handleApprove = useCallback(() => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);

    const assignments: ExecutionPlanFileAssignment[] = [];
    for (const { folder, scope, extension } of allFolders) {
      for (const file of folder.files) {
        assignments.push({
          fileName: file.fileName,
          category: folder.category,
          folderName: folder.category,
          scope,
          ...(extension !== undefined ? { extension } : {}),
        });
      }
    }

    setSubmitted(true);
    onSubmit(request.inputId, 'approve', assignments);
  }, [allFolders, validate, request.inputId, onSubmit]);

  const handleSendMessage = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setSubmitted(true);
    onSubmit(request.inputId, 'message', undefined, trimmed);
  }, [request.inputId, message, onSubmit]);

  if (submitted) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="flex items-center gap-2 text-sm text-[#8a5a3d]">
          <Check size={16} strokeWidth={2.5} className="text-[#15803d] flex-shrink-0" />
          <span className="font-medium text-[#57341f]">{mode === 'changes' ? 'Message sent — waiting for agent…' : 'Approved — moving files…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-[#f3ddcd] bg-gradient-to-br from-[#fdf1ec] to-[#f9f1ea]">
        <span className="text-base font-semibold text-[#57341f]">Final Move Plan</span>
        <p className="text-xs text-[#8a5a3d] mt-0.5">
          Drag files between folders, rename or delete folders, or create new ones — then approve when it's right.
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        {tree.map(sg => (
          <ScopeSection
            key={sg.scope}
            scopeGroup={sg}
            dragOverFolderId={dragOverFolderId}
            setDragOverFolderId={setDragOverFolderId}
            onMoveFile={moveFile}
            onRenameFolder={renameFolder}
            onDeleteFolder={deleteFolder}
            onCreateFolder={createFolder}
          />
        ))}

        {request.unassignedCount > 0 && (
          <div className="px-3 py-2 rounded-lg bg-[#fef2f2] text-[11px] text-[#991b1b]">
            ⚠ {request.unassignedCount} file(s) have no destination folder assigned and will be skipped.
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 px-6 py-4 border-t border-[#f3ddcd]">
        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-[#fef2f2] text-[11px] text-[#991b1b]">
            {error}
          </div>
        )}

        {mode === 'idle' && (
          <div className="flex gap-2">
            <button
              onClick={handleApprove}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold text-white"
              style={{ background: 'var(--color-accent)', boxShadow: '0 2px 8px rgba(194,97,61,0.3)' }}
            >
              <Check size={14} strokeWidth={2.5} />
              Approve & Move Files
            </button>
            <button
              onClick={() => setMode('changes')}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-[#8a5a3d] bg-white border border-[#e8cab8] hover:bg-[#fdf1ec]"
            >
              Request Changes
            </button>
          </div>
        )}

        {mode === 'changes' && (
          <div>
            <p className="text-xs text-[#8a5a3d] mb-2 font-medium">
              Describe what you'd like the agent to redo (e.g. "split documents differently"):
            </p>
            <div className="flex gap-2 items-end">
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                rows={2}
                placeholder="e.g. recategorize the PDFs by year instead…"
                className="flex-1 px-3 py-2 rounded-lg text-[13px] text-[#57341f] bg-white border border-[#e8cab8] outline-none resize-none"
              />
              <button
                onClick={handleSendMessage}
                disabled={!message.trim()}
                className="px-3 h-[38px] rounded-lg text-xs font-semibold flex-shrink-0 disabled:cursor-not-allowed"
                style={{
                  background: message.trim() ? 'var(--color-accent)' : '#f3ddcd',
                  color: message.trim() ? 'white' : '#b89178',
                }}
              >
                Send
              </button>
            </div>
            <button
              onClick={() => { setMode('idle'); setMessage(''); }}
              className="mt-1.5 text-[11px] text-[#b89178]"
            >
              ← Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

interface ScopeSectionProps {
  scopeGroup: EditableScopeGroup;
  dragOverFolderId: string | null;
  setDragOverFolderId: (id: string | null) => void;
  onMoveFile: (fileName: string, sourceFolderId: string, targetFolderId: string) => void;
  onRenameFolder: (folderId: string, newName: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onCreateFolder: (scope: PlanScope, extension: string | undefined, name: string) => void;
}

const ScopeSection: React.FC<ScopeSectionProps> = ({
  scopeGroup, dragOverFolderId, setDragOverFolderId, onMoveFile, onRenameFolder, onDeleteFolder, onCreateFolder,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const totalFiles = useMemo(() => {
    let count = 0;
    scopeGroup.extensionGroups?.forEach(eg => eg.folders.forEach(f => count += f.files.length));
    scopeGroup.folders?.forEach(f => count += f.files.length);
    return count;
  }, [scopeGroup]);

  return (
    <div>
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-1.5 w-full text-left cursor-pointer mb-2"
      >
        <ChevronRight
          size={12}
          strokeWidth={2.5}
          className={`flex-shrink-0 text-[#8a5a3d] transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
        />
        <span className="text-[12px] font-semibold text-[#57341f]">{SCOPE_LABELS[scopeGroup.scope]}</span>
        <span className="text-[10px] text-[#8a5a3d] font-mono">({totalFiles})</span>
      </button>

      {!collapsed && (
        <div className="space-y-3 ml-1">
          {scopeGroup.extensionGroups?.map(eg => (
            <div key={eg.extension}>
              <div className="text-[10px] font-mono text-[#8a5a3d] mb-1.5">{eg.extension}</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {eg.folders.map(folder => (
                  <FolderCard
                    key={folder.id}
                    folder={folder}
                    isDragOver={dragOverFolderId === folder.id}
                    setDragOverFolderId={setDragOverFolderId}
                    onMoveFile={onMoveFile}
                    onRename={onRenameFolder}
                    onDelete={onDeleteFolder}
                  />
                ))}
                <NewFolderCard onCreate={name => onCreateFolder(scopeGroup.scope, eg.extension, name)} />
              </div>
            </div>
          ))}

          {scopeGroup.folders && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {scopeGroup.folders.map(folder => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  isDragOver={dragOverFolderId === folder.id}
                  setDragOverFolderId={setDragOverFolderId}
                  onMoveFile={onMoveFile}
                  onRename={onRenameFolder}
                  onDelete={onDeleteFolder}
                />
              ))}
              <NewFolderCard onCreate={name => onCreateFolder(scopeGroup.scope, undefined, name)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface FolderCardProps {
  folder: EditableFolder;
  isDragOver: boolean;
  setDragOverFolderId: (id: string | null) => void;
  onMoveFile: (fileName: string, sourceFolderId: string, targetFolderId: string) => void;
  onRename: (folderId: string, newName: string) => void;
  onDelete: (folderId: string) => void;
}

const FolderCard: React.FC<FolderCardProps> = ({ folder, isDragOver, setDragOverFolderId, onMoveFile, onRename, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(folder.category);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setNameDraft(folder.category);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (trimmed) onRename(folder.id, trimmed);
    setEditing(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverFolderId(folder.id);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverFolderId(null);
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    try {
      const payload: DragPayload = JSON.parse(raw);
      onMoveFile(payload.fileName, payload.sourceFolderId, folder.id);
    } catch {
      // malformed drag payload — ignore
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOverFolderId(null)}
      onDrop={handleDrop}
      className={`flex-shrink-0 w-[210px] rounded-lg border bg-white/70 flex flex-col transition-colors ${
        isDragOver ? 'border-[#c2613d] bg-[#fdf1ec]' : 'border-[#f3ddcd]'
      }`}
    >
      <div className="flex items-center gap-1 px-2.5 py-2 border-b border-[#f3ddcd]">
        {editing ? (
          <input
            ref={inputRef}
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="flex-1 min-w-0 text-[12px] font-semibold text-[#57341f] bg-white border border-[#c2613d] rounded px-1 outline-none"
          />
        ) : (
          <button onClick={startEditing} className="flex-1 min-w-0 flex items-center gap-1 text-left group">
            <span className="text-[12px] font-semibold text-[#57341f] truncate">{folder.category}</span>
            <Pencil size={10} className="flex-shrink-0 text-[#c4a892] opacity-0 group-hover:opacity-100" />
          </button>
        )}
        <span className="text-[10px] text-[#8a5a3d] flex-shrink-0">{folder.files.length}</span>
        <button
          onClick={() => onDelete(folder.id)}
          disabled={folder.files.length > 0}
          title={folder.files.length > 0 ? 'Move all files out before deleting' : 'Delete this folder'}
          className="flex-shrink-0 text-[#c4a892] hover:text-[#991b1b] disabled:opacity-30 disabled:hover:text-[#c4a892] disabled:cursor-not-allowed"
        >
          <Trash2 size={11} />
        </button>
      </div>

      <div className="flex-1 max-h-[260px] overflow-y-auto px-2.5 py-1.5 space-y-1">
        {folder.files.length === 0 ? (
          <p className="text-[10px] text-[#c4a892] italic py-2 text-center">Drop files here</p>
        ) : (
          folder.files.map(file => <FileRow key={file.fileName} file={file} sourceFolderId={folder.id} />)
        )}
      </div>
    </div>
  );
};

const FileRow: React.FC<{ file: EditableFile; sourceFolderId: string }> = ({ file, sourceFolderId }) => {
  const handleDragStart = (e: React.DragEvent) => {
    const payload: DragPayload = { fileName: file.fileName, sourceFolderId };
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      title={file.fileName}
      className="text-[10px] text-[#57341f] truncate cursor-grab active:cursor-grabbing rounded px-1 py-0.5 hover:bg-[#fdf1ec] flex justify-between gap-1"
    >
      <span className="truncate">{file.fileName}</span>
      <span className="text-[#c4a892] flex-shrink-0">{formatSize(file.fileSize)}</span>
    </div>
  );
};

const NewFolderCard: React.FC<{ onCreate: (name: string) => void }> = ({ onCreate }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setName('');
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex-shrink-0 w-[210px] rounded-lg border border-[#c2613d] bg-white/70 px-2.5 py-2 flex items-center gap-1">
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="Folder name…"
          className="flex-1 min-w-0 text-[12px] text-[#57341f] bg-white border border-[#e8cab8] rounded px-1 outline-none"
        />
        <button onClick={() => setEditing(false)} className="text-[#c4a892] flex-shrink-0">
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={startEditing}
      className="flex-shrink-0 w-[210px] rounded-lg border border-dashed border-[#e8cab8] bg-transparent flex items-center justify-center gap-1.5 py-6 text-[#8a5a3d] hover:bg-[#fdf1ec] hover:border-[#c2613d]"
    >
      <Plus size={13} strokeWidth={2.5} />
      <span className="text-[11px] font-medium">New folder</span>
    </button>
  );
};
