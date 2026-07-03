// Global type augmentation for the Electron context bridge API
// exposed by electron/preload.ts via contextBridge.exposeInMainWorld('electronAPI', ...)

export type MessageType = 'agent' | 'user' | 'system' | 'task_update';
export type LogType = 'tool_call' | 'tool_result' | 'pipeline' | 'error' | 'info';
export type AgentStage = 'planning' | 'categorization' | 'execution' | 'done' | 'idle';

export interface AgentMessage {
  type: MessageType;
  stage: AgentStage;
  content: string;
  timestamp: number;
  /**
   * Stable identity for messages that represent the same ongoing unit of work.
   * When set, the renderer updates the existing bubble in place instead of appending a new one.
   */
  groupId?: string;
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

export type TodoStatus = 'not-started' | 'in-progress' | 'completed' | 'blocked' | 'failed';

/** Finalized folder → file breakdown, shown only after approval (never during pending review). */
export interface FolderPreviewEntry {
  category: string;
  folder: string;
  files: string[];
  totalFileCount: number;
}

/** Per-extension sub-progress, populated only for the Documents task. */
export interface TodoSubTask {
  extension: string;
  status: TodoStatus;
  folderPreview?: FolderPreviewEntry[];
}

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
  notes?: string;
  extensionList: string[];
  subTasks?: TodoSubTask[];
  folderPreview?: FolderPreviewEntry[];
}

/** Payload sent from main → renderer whenever the todo list is created or a task/sub-task status changes. */
export interface AgentTodoUpdateEvent {
  todoList: TodoItem[];
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

export type PlanScope = 'documents' | 'images' | 'non-documents';

export interface PlanFileEntry {
  fileName: string;
  fileSize: number;
}

export interface PlanFolderEntry {
  category: string;
  folder: string;
  files: PlanFileEntry[];
}

export interface PlanExtensionGroup {
  extension: string;
  folders: PlanFolderEntry[];
}

/** Documents populates extensionGroups; Images/Non-Documents populate folders directly. */
export interface PlanScopeGroup {
  scope: PlanScope;
  extensionGroups?: PlanExtensionGroup[];
  folders?: PlanFolderEntry[];
}

/** Payload sent from main → renderer to render the editable final execution plan, before files are moved on disk. */
export interface ExecutionPlanRequest {
  inputId: string;
  scopes: PlanScopeGroup[];
  unassignedCount: number;
}

/** One file's final destination, as edited by the user in the plan panel. */
export interface ExecutionPlanFileAssignment {
  fileName: string;
  category: string;
  folderName: string;
  scope: PlanScope;
  extension?: string;
}

export interface ElectronAPI {
  // Renderer → Main
  sendFolderReview: (inputId: string, action: 'approve' | 'message', message?: string) => void;
  sendScopeSelection: (inputId: string, action: 'submit' | 'message', selected?: CategorySummary, message?: string) => void;
  sendExecutionPlanResponse: (inputId: string, action: 'approve' | 'decline' | 'message', assignments?: ExecutionPlanFileAssignment[], message?: string) => void;
  startAgent: (userMessage: string) => void;
  selectFolder: () => Promise<string | null>;

  // Main → Renderer (event listeners)
  onMessage: (callback: (msg: AgentMessage) => void) => () => void;
  onLog: (callback: (log: AgentLog) => void) => () => void;
  onStage: (callback: (event: AgentStageEvent) => void) => () => void;
  onTodoUpdate: (callback: (event: AgentTodoUpdateEvent) => void) => () => void;
  onFolderReviewRequest: (callback: (payload: FolderReviewRequest) => void) => () => void;
  onScopeSelectionRequest: (callback: (payload: ScopeSelectionRequest) => void) => () => void;
  onExecutionPlanRequest: (callback: (payload: ExecutionPlanRequest) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

