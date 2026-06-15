/**
 * preload.ts
 * 
 * Electron preload script — runs in an isolated context with access to both
 * the Node.js APIs and the renderer's window. Exposes a safe `electronAPI`
 * object to the React app via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentMessage, AgentLog, AgentStageEvent } from './ipcBridge.js';

// Re-export types for renderer consumption
export type { AgentMessage, AgentLog, AgentStageEvent };

export interface ElectronAPI {
  // Renderer → Main
  sendInput: (inputId: string, value: string) => void;
  startAgent: (userMessage: string) => void;
  selectFolder: () => Promise<string | null>;

  // Main → Renderer (event listeners)
  onMessage: (callback: (msg: AgentMessage) => void) => () => void;
  onLog: (callback: (log: AgentLog) => void) => () => void;
  onStage: (callback: (event: AgentStageEvent) => void) => () => void;
  onInputRequest: (callback: (payload: { promptLabel: string; inputId: string }) => void) => () => void;
}

contextBridge.exposeInMainWorld('electronAPI', {
  sendInput: (inputId: string, value: string) => {
    ipcRenderer.send('agent:user_input', { inputId, value });
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
} satisfies ElectronAPI);
