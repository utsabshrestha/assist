/**
 * ipcBridge.ts
 * 
 * Central communication hub between the agent (main process) and the UI (renderer).
 * All agent/tool console output and user input requests go through here.
 * 
 * This module is imported by agent code. It holds a reference to the
 * BrowserWindow's webContents so it can push events to the renderer.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { EventEmitter } from 'events';
import type { FolderPlanEntry, CategorySummary, TodoItem, FolderPreviewEntry } from '../src/state/fileAgentState.js';

export type MessageType = 'agent' | 'user' | 'system' | 'task_update';
export type LogType = 'tool_call' | 'tool_result' | 'pipeline' | 'error' | 'info';
export type AgentStage = 'planning' | 'categorization' | 'execution' | 'done' | 'idle';

// Re-export so consumers don't need a separate import
export type { FolderPlanEntry, CategorySummary, TodoItem, FolderPreviewEntry };

export interface AgentMessage {
  type: MessageType;
  stage: AgentStage;
  content: string;
  timestamp: number;
  /**
   * Stable identity for messages that represent the same ongoing unit of work
   * (e.g. a task or extension's progress). When set, the renderer updates the
   * existing bubble with this groupId in place instead of appending a new one.
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

/** Sent from main → renderer whenever the todo list is created or a task/sub-task status changes. */
export interface AgentTodoUpdateEvent {
  todoList: TodoItem[];
}

/** Sent from main → renderer to show the structured folder review panel. */
export interface FolderReviewRequest {
  inputId: string;
  extension: string;
  folders: FolderPlanEntry[];
}

/** Sent from renderer → main after the user clicks Approve or submits a change request. */
export interface FolderReviewResponse {
  inputId: string;
  action: 'approve' | 'message';
  message?: string; // populated when action === 'message'
}

/** Sent from main → renderer to show the structured scope-selection checklist. */
export interface ScopeSelectionRequest {
  inputId: string;
  categories: CategorySummary;
  fileCountByExtension: Record<string, number>;
  totalFileCount: number;
  totalFileSize: string;
}

/** Sent from renderer → main after the user submits the checklist or a change request. */
export interface ScopeSelectionResponse {
  inputId: string;
  action: 'submit' | 'message';
  selected?: CategorySummary; // populated when action === 'submit'; only checked categories included
  message?: string; // populated when action === 'message'
}

// Internal event emitter to receive user input from the renderer
const inputEmitter = new EventEmitter();
let mainWindow: BrowserWindow | null = null;
let currentStage: AgentStage = 'idle';
let inputIdCounter = 0;

/**
 * Called once from main.ts after the BrowserWindow is created.
 */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;

  // Listen for plain text user input
  ipcMain.on('agent:user_input', (_event, payload: { inputId: string; value: string }) => {
    inputEmitter.emit(`input:${payload.inputId}`, payload.value);
  });

  // Listen for structured folder review responses (Approve or Message)
  ipcMain.on('agent:folder_review_response', (_event, payload: FolderReviewResponse) => {
    inputEmitter.emit(`input:${payload.inputId}`, payload);
  });

  // Listen for structured scope selection responses (Submit or Message)
  ipcMain.on('agent:scope_selection_response', (_event, payload: ScopeSelectionResponse) => {
    inputEmitter.emit(`input:${payload.inputId}`, payload);
  });
}

/**
 * Emit a chat message (main panel).
 */
export function emitAgentMessage(content: string, type: MessageType = 'agent', groupId?: string): void {
  const msg: AgentMessage = { type, stage: currentStage, content, timestamp: Date.now(), ...(groupId !== undefined ? { groupId } : {}) };
  // Always keep a console copy for debugging
  console.log(`[${type.toUpperCase()}][${currentStage}] ${content}`);
  mainWindow?.webContents.send('agent:message', msg);
}

/**
 * Emit a log entry (side panel).
 */
export function emitLog(content: string, type: LogType = 'info', name?: string): void {
  const log: AgentLog = { type, content, timestamp: Date.now(), ...(name !== undefined ? { name } : {}) };
  console.log(`[LOG:${type}]${name ? `[${name}]` : ''} ${content}`);
  mainWindow?.webContents.send('agent:log', log);
}

/**
 * Emit the current pipeline stage update.
 */
export function emitStage(stage: AgentStage): void {
  currentStage = stage;
  console.log(`[STAGE] → ${stage}`);
  mainWindow?.webContents.send('agent:stage', { stage } as AgentStageEvent);
}

/**
 * Broadcast the current todo list snapshot to the renderer.
 * One-way, fire-and-forget — no response leg, since this is a passive status display.
 */
export function emitTodoUpdate(todoList: TodoItem[]): void {
  mainWindow?.webContents.send('agent:todo_update', { todoList } as AgentTodoUpdateEvent);
}

/**
 * Request input from the user via the UI.
 * Returns a Promise that resolves when the user submits input from the renderer.
 */
export function requestUserInput(promptLabel: string): Promise<string> {
  return new Promise((resolve) => {
    const inputId = `input_${++inputIdCounter}_${Date.now()}`;
    
    // One-time listener for this specific input
    inputEmitter.once(`input:${inputId}`, (value: string) => {
      // Echo what the user typed back as a "user" message in chat
      emitAgentMessage(value, 'user');
      resolve(value);
    });

    // Ask the renderer to show the input box
    mainWindow?.webContents.send('agent:input_request', { promptLabel, inputId });
  });
}

/**
 * Show the structured folder review panel in the renderer.
 * Blocks until the user clicks Approve or submits a change request.
 */
export function requestFolderReview(extension: string, folders: FolderPlanEntry[]): Promise<FolderReviewResponse> {
  return new Promise((resolve) => {
    const inputId = `folder_review_${++inputIdCounter}_${Date.now()}`;

    // One-time listener — resolves with the typed response object
    inputEmitter.once(`input:${inputId}`, (payload: FolderReviewResponse) => {
      resolve(payload);
    });

    const request: FolderReviewRequest = { inputId, extension, folders };
    mainWindow?.webContents.send('agent:folder_review_request', request);
  });
}

/**
 * Show the structured scope-selection checklist in the renderer.
 * Blocks until the user submits the checklist or sends a change request.
 */
export function requestScopeSelection(
  categories: CategorySummary,
  fileCountByExtension: Record<string, number>,
  totalFileCount: number,
  totalFileSize: string
): Promise<ScopeSelectionResponse> {
  return new Promise((resolve) => {
    const inputId = `scope_selection_${++inputIdCounter}_${Date.now()}`;

    inputEmitter.once(`input:${inputId}`, (payload: ScopeSelectionResponse) => {
      resolve(payload);
    });

    const request: ScopeSelectionRequest = { inputId, categories, fileCountByExtension, totalFileCount, totalFileSize };
    mainWindow?.webContents.send('agent:scope_selection_request', request);
  });
}
