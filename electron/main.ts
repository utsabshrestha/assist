/**
 * main.ts
 *
 * Electron main process entry point.
 * Creates the BrowserWindow, wires up IPC, and starts the agent pipeline.
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { setMainWindow, emitStage } from './ipcBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // Register the window with the IPC bridge
  setMainWindow(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow!.show();
  });

  if (isDev) {
    // Wait for Vite dev server (started via concurrently)
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  }
}

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// =============================================
// IPC: Native folder picker dialog
// =============================================
ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
    title: 'Select folder to organize',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// =============================================
// IPC: Start the agent when the renderer asks
// =============================================
ipcMain.on('agent:start', async (_event, payload: { userMessage: string }) => {
  try {
    // Dynamically import agent so it has access to the already-configured ipcBridge
    const { fileAgent } = await import('../src/agent.js');
    emitStage('planning');
    await fileAgent.chatLoop(payload.userMessage);
    emitStage('done');
  } catch (err: any) {
    console.error('Agent pipeline error:', err);
    const { emitLog } = await import('./ipcBridge.js');
    emitLog(`Fatal error: ${err?.message ?? String(err)}`, 'error');
  }
});
