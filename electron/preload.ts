/**
 * preload.ts
 * 
 * Electron preload script — runs in an isolated context with access to both
 * the Node.js APIs and the renderer's window. Exposes a safe `electronAPI`
 * object to the React app via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentMessage, AgentLog, AgentStageEvent, AgentTodoUpdateEvent, FolderReviewRequest, FolderReviewResponse, ScopeSelectionRequest, ScopeSelectionResponse, CategorySummary, TodoItem, FolderPreviewEntry } from './ipcBridge.js';

// Re-export types for renderer consumption
export type { AgentMessage, AgentLog, AgentStageEvent, AgentTodoUpdateEvent, FolderReviewRequest, FolderReviewResponse, ScopeSelectionRequest, ScopeSelectionResponse, CategorySummary, TodoItem, FolderPreviewEntry };

export interface ElectronAPI {
  // Renderer → Main
  sendInput: (inputId: string, value: string) => void;
  sendFolderReview: (inputId: string, action: 'approve' | 'message', message?: string) => void;
  sendScopeSelection: (inputId: string, action: 'submit' | 'message', selected?: CategorySummary, message?: string) => void;
  startAgent: (userMessage: string) => void;
  selectFolder: () => Promise<string | null>;

  // Main → Renderer (event listeners)
  onMessage: (callback: (msg: AgentMessage) => void) => () => void;
  onLog: (callback: (log: AgentLog) => void) => () => void;
  onStage: (callback: (event: AgentStageEvent) => void) => () => void;
  onTodoUpdate: (callback: (event: AgentTodoUpdateEvent) => void) => () => void;
  onInputRequest: (callback: (payload: { promptLabel: string; inputId: string }) => void) => () => void;
  onFolderReviewRequest: (callback: (payload: FolderReviewRequest) => void) => () => void;
  onScopeSelectionRequest: (callback: (payload: ScopeSelectionRequest) => void) => () => void;
}

contextBridge.exposeInMainWorld('electronAPI', {
  sendInput: (inputId: string, value: string) => {
    ipcRenderer.send('agent:user_input', { inputId, value });
  },

  sendFolderReview: (inputId: string, action: 'approve' | 'message', message?: string) => {
    const payload: FolderReviewResponse = { inputId, action, ...(message !== undefined ? { message } : {}) };
    ipcRenderer.send('agent:folder_review_response', payload);
  },

  sendScopeSelection: (inputId: string, action: 'submit' | 'message', selected?: CategorySummary, message?: string) => {
    const payload: ScopeSelectionResponse = {
      inputId,
      action,
      ...(selected !== undefined ? { selected } : {}),
      ...(message !== undefined ? { message } : {})
    };
    ipcRenderer.send('agent:scope_selection_response', payload);
  },


  startAgent: (userMessage: string) => {
    ipcRenderer.send('agent:start', { userMessage });
  },

  selectFolder: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:select-folder');
  },

  onMessage: (callback: (msg: AgentMessage) => void) => {
    const handler = (_: Electron.IpcRendererEvent, msg: AgentMessage) => callback(msg);
    ipcRenderer.on('agent:message', handler);
    return () => ipcRenderer.removeListener('agent:message', handler);
  },

  onLog: (callback: (log: AgentLog) => void) => {
    const handler = (_: Electron.IpcRendererEvent, log: AgentLog) => callback(log);
    ipcRenderer.on('agent:log', handler);
    return () => ipcRenderer.removeListener('agent:log', handler);
  },

  onStage: (callback: (event: AgentStageEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: AgentStageEvent) => callback(event);
    ipcRenderer.on('agent:stage', handler);
    return () => ipcRenderer.removeListener('agent:stage', handler);
  },

  onInputRequest: (callback: (payload: { promptLabel: string; inputId: string }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: { promptLabel: string; inputId: string }) => callback(payload);
    ipcRenderer.on('agent:input_request', handler);
    return () => ipcRenderer.removeListener('agent:input_request', handler);
  },

  onFolderReviewRequest: (callback: (payload: FolderReviewRequest) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: FolderReviewRequest) => callback(payload);
    ipcRenderer.on('agent:folder_review_request', handler);
    return () => ipcRenderer.removeListener('agent:folder_review_request', handler);
  },

  onScopeSelectionRequest: (callback: (payload: ScopeSelectionRequest) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: ScopeSelectionRequest) => callback(payload);
    ipcRenderer.on('agent:scope_selection_request', handler);
    return () => ipcRenderer.removeListener('agent:scope_selection_request', handler);
  },

  onTodoUpdate: (callback: (event: AgentTodoUpdateEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, event: AgentTodoUpdateEvent) => callback(event);
    ipcRenderer.on('agent:todo_update', handler);
    return () => ipcRenderer.removeListener('agent:todo_update', handler);
  },
} satisfies ElectronAPI);
