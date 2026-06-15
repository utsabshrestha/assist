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

  // Listen for user input coming back from the renderer
  ipcMain.on('agent:user_input', (_event, payload: { inputId: string; value: string }) => {
    inputEmitter.emit(`input:${payload.inputId}`, payload.value);
  });
}

/**
 * Emit a chat message (main panel).
 */
export function emitAgentMessage(content: string, type: MessageType = 'agent'): void {
  const msg: AgentMessage = { type, stage: currentStage, content, timestamp: Date.now() };
  // Always keep a console copy for debugging
  console.log(`[${type.toUpperCase()}][${currentStage}] ${content}`);
  mainWindow?.webContents.send('agent:message', msg);
}

/**
 * Emit a log entry (side panel).
 */
export function emitLog(content: string, type: LogType = 'info', name?: string): void {
  const log: AgentLog = { type, name, content, timestamp: Date.now() };
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
