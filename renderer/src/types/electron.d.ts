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

/** One row in the folder plan: a category name + the full absolute folder path. */
export interface FolderPlanEntry {
  category: string;
  folder: string;
}

/** Payload sent from main → renderer to render the folder review panel. */
export interface FolderReviewRequest {
  inputId: string;
  extension: string;
  folders: FolderPlanEntry[];
}

/** Category → extension list, e.g. { documents: ['.pdf', '.docx'], images: [...], "non-documents": [...] } */
export interface CategorySummary {
  documents: string[];
  images: string[];
  "non-documents": string[];
}

/** Payload sent from main → renderer to render the scope-selection checklist. */
export interface ScopeSelectionRequest {
  inputId: string;
  categories: CategorySummary;
  fileCountByExtension: Record<string, number>;
  totalFileCount: number;
  totalFileSize: string;
}

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
  onInputRequest: (callback: (payload: { promptLabel: string; inputId: string }) => void) => () => void;
  onFolderReviewRequest: (callback: (payload: FolderReviewRequest) => void) => () => void;
  onScopeSelectionRequest: (callback: (payload: ScopeSelectionRequest) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

