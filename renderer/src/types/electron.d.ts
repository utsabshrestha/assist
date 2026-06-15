// Global type augmentation for the Electron context bridge API
// exposed by electron/preload.ts via contextBridge.exposeInMainWorld('electronAPI', ...)

export type MessageType = 'agent' | 'user' | 'system';
export type LogType = 'tool_call' | 'tool_result' | 'pipeline' | 'error' | 'info';
export type AgentStage = 'planning' | 'categorization' | 'execution' | 'done' | 'idle';

export interface AgentMessage {
  type: MessageType;
  stage: AgentStage;
  content: string;
  timestamp: number;
}

export interface AgentLog {
  type: LogType;
  name?: string;
  content: string;
  timestamp: number;
}

export interface AgentStageEvent {
  stage: AgentStage;
}

export interface ElectronAPI {
  sendInput: (inputId: string, value: string) => void;
  startAgent: (userMessage: string) => void;
  selectFolder: () => Promise<string | null>;
  onMessage: (callback: (msg: AgentMessage) => void) => () => void;
  onLog: (callback: (log: AgentLog) => void) => () => void;
  onStage: (callback: (event: AgentStageEvent) => void) => () => void;
  onInputRequest: (callback: (payload: { promptLabel: string; inputId: string }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
