import path from "path";
import { fileAgentRecord, fileStatus } from "../src/state/fileAgentState.js";
import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import { ErrorEncountered, HandOffToCategorizationAgent } from '../tools/pipelineTools.js';
import { emitLog, emitAgentMessage, requestScopeSelection, emitTodoUpdate } from '../electron/ipcBridge.js';
import type { CategorySummary } from "../src/state/fileAgentState.js";

/**
 * Planning Agent 1 — Planning Agent tool set.
 *
 * Responsibilities: understand the workspace, discuss scope with user,
 * build the todo list, record constraints, then hand off to Categorization Agent.
 */

/** Matches transient files created by other apps (Office locks, swap files, OS metadata, partial downloads) so they're never treated as real files to organize. */
function isTemporaryFile(name: string): boolean {
    return (
        name === '.DS_Store' ||
        name === 'Thumbs.db' ||
        name === 'desktop.ini' ||
        name.startsWith('~$') ||           // MS Office lock files, e.g. ~$report.docx
        name.startsWith('.~lock.') ||      // LibreOffice lock files, e.g. .~lock.report.odt#
        /^\.goutputstream-/.test(name) ||  // GNOME gvfs temp files
        /\.(swp|swo|swx)$/.test(name) ||   // vim swap files
        /\.tmp$/i.test(name) ||
        /\.crdownload$/i.test(name) ||     // Chrome in-progress download
        /\.part$/i.test(name) ||           // Firefox in-progress download
        /\.download$/i.test(name) ||       // Safari in-progress download
        /^\.#/.test(name) ||               // Emacs lock files
        /#$/.test(name)                    // Emacs/LibreOffice trailing-# temp files
    );
}

/** Renders the scanned category/extension/count breakdown as plain text for the LLM to read. */
function formatCategoryBreakdown(categories: CategorySummary, countByExt: Record<string, number>): string {
    return (['documents', 'images', 'non-documents'] as const)
        .filter(cat => categories[cat].length > 0)
        .map(cat => `${cat}: ${categories[cat].map(ext => `${ext}(${countByExt[ext] ?? 0})`).join(', ')}`)
        .join('\n');
}


const GetFolderSummaryTool = ({
    description: "This tool will provide total number of files in the folder, categorized list of file extensions (documents, images, non-documents), number of files per extension, total size, list of directories inside the folder.",
    params: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Absolute path of the folder to analyze."
            },
            ProcessId: {
                type: "string",
                description: "The unique process id for this session, provided by the user."
            },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Scanning your folder for files...'. This will be shown directly to the user."
            }
        },
        required: ["path", "ProcessId", "statusMessage"]
    },
    async handler(params: { ProcessId: string, path: string, statusMessage: string }): Promise<string> {
        // emitLog(`getFolderSummary → ${params.path}`, 'tool_call', 'GetFolderSummaryTool');
        emitAgentMessage(params.statusMessage, 'agent');
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        try {
            await fs.access(params.path);
        } catch {
            return `Error: Workspace folder does not exist: '${params.path}'. Folders must be exist to organize the files.`;
        }

        try {
            state.workspacePath = params.path;
            const entries = await fs.readdir(state.workspacePath, { withFileTypes: true });
            const files = entries
                .filter((e: Dirent) => e.isFile() && !isTemporaryFile(e.name))
                .sort((a: Dirent, b: Dirent) => a.name.localeCompare(b.name));
            let totalFileSize: number = 0;

            await Promise.all(files.map(async (file: Dirent) => {
                const fullPath = path.join(state.workspacePath, file.name);
                try {
                    const stats = await fs.stat(fullPath);
                    const sizeKB = parseFloat((stats.size / 1024).toFixed(2));
                    totalFileSize += sizeKB;
                    const ext = path.extname(file.name).toLowerCase() || "no extension";

                    // Assign default categories based on common file extensions
                    let defaultCategory = "";
                    // if (['.jpg', '.png', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
                    //     defaultCategory = "Images";
                    // }
                    // Image extensions are NOT assigned a default category here;
                    // the ImageCategorizationAgent handles them with vision-based analysis. 

                    if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
                        defaultCategory = "Videos";
                    } else if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) {
                        defaultCategory = "Archives";
                    } else if (['.exe', '.app', '.dmg', '.pkg', '.msi'].includes(ext)) {
                        defaultCategory = "Applications";
                    } else if (['.mp3', '.wav', '.flac', '.ogg'].includes(ext)) {
                        defaultCategory = "Audio";
                    }

                    const newFileStatus = new fileStatus(file.name, fullPath, sizeKB, ext);
                    if (defaultCategory) newFileStatus.category = defaultCategory;
                    state.AddFile(newFileStatus);
                } catch (ex) {
                    emitLog(`Error encountered while listing files ${ex}`, 'error');
                }
            }));

            const fileCountByExt: Record<string, number> = {};
            Object.entries(state.fileByExtension).forEach(([extensions, list]) => {
                fileCountByExt[extensions] = list.length;
            })

            const extensions: string[] = Array.from(new Set(
                files.map((f: Dirent) => path.extname(f.name).toLowerCase()).filter((e: string) => e !== '')
            ));

            const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.ico', '.bmp', '.tiff'];
            const documentExtensions = ['.pdf', '.docx', '.doc', '.txt', '.xlsx', '.xls', '.csv', '.ppt', '.pptx', '.json', '.md', '.epub', '.html', '.htm', '.xml'];

            const categories = {
                documents: [] as string[],
                images: [] as string[],
                "non-documents": [] as string[]
            };

            extensions.forEach(ext => {
                if (imageExtensions.includes(ext)) {
                    categories.images.push(ext);
                } else if (documentExtensions.includes(ext)) {
                    categories.documents.push(ext);
                } else {
                    categories["non-documents"].push(ext);
                }
            });

            // const directories = await getAllDirectories(state.workspacePath, state.workspacePath, 0);


            state.filesCount = files.length;
            state.extensions = extensions;
            state.lastReadInd = 0;
            state.categorySummary = categories;
            state.fileCountByExtension = fileCountByExt;
            state.totalFileSizeLabel = `${(totalFileSize / 1024).toFixed(2)} MB`;

            const categoryCount = Object.values(categories).filter(list => list.length > 0).length;
            const breakdown = formatCategoryBreakdown(categories, fileCountByExt);
            const message = {
                fileCount: files.length,
                categories: breakdown,
                categoryCount: categoryCount,
                instruction: "Call PresentScopeSelectionTool now to let the user choose what to organize."
            }
            return JSON.stringify(message);
        } catch (e: any) {
            return `We have encountered Error reading folder: ${e.message}, please report to the user immediately.`;
        }
    }
});

const PresentScopeSelectionTool = ({
    description: "Presents the folder's file categories (documents, images, non-documents) to the user via a structured checklist UI so they can pick what to organize. Call this immediately after GetFolderSummaryTool — do NOT describe the categories yourself in chat. Returns the user's selected categories and their extensions as JSON to use directly when building the todo list, or a USER_MESSAGE if the user typed a custom request instead.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session." },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message shown to the user before the checklist appears, e.g. 'Here's what I found — pick what you'd like organized.'"
            }
        },
        required: ["ProcessId", "statusMessage"]
    },
    async handler(params: { ProcessId: string; statusMessage: string }): Promise<string> {
        // emitLog(`PresentScopeSelectionTool → ${params.ProcessId}`, 'tool_call', 'PresentScopeSelectionTool');
        emitAgentMessage(params.statusMessage, 'user');
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const response = await requestScopeSelection(
            state.categorySummary,
            state.fileCountByExtension,
            state.filesCount,
            state.totalFileSizeLabel
        );

        if (response.action === 'message') {
            emitAgentMessage("Got it — let me adjust that...", 'system');
            const breakdown = formatCategoryBreakdown(state.categorySummary, state.fileCountByExtension);
            return `USER_MESSAGE: ${response.message ?? 'User declined without a message. Ask what they would like to change.'}\n\nHere is what was found in the folder (category: extension(count)):\n${breakdown}`;
        }

        emitAgentMessage("Got it — building your task list now...", 'system');
        const selected = response.selected ?? { documents: [], images: [], "non-documents": [] };
        const tasks = Object.entries(selected)
            .filter(([, extensionList]) => extensionList.length > 0)
            .map(([category, extensionList]) => ({ category, extensionList }));

        return JSON.stringify({
            selection: "SCOPE_SELECTED",
            tasks
        });
    }
});


const getAllDirectories = async (dirPath: string, basePath: string = '', subFolder: number): Promise<string[]> => {
    let dirs: string[] = [];
    subFolder++;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const relPath = path.join(basePath, entry.name);
            dirs.push(relPath);
            if (subFolder < 3) {
                const subDirs = await getAllDirectories(path.join(dirPath, entry.name), relPath, subFolder);
                dirs = dirs.concat(subDirs);
            }
        }
    }
    return dirs;
};


const MemoryScratchpadTool = ({
    description: "A secure scratchpad to record your thoughts, specify user constraints, or note down findings. Use 'add_note' to append a note, and 'view' to read all notes.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            action: { type: "string", enum: ["add_note", "view"], description: "Action to perform on scratchpad." },
            note: { type: "string", description: "The content to remember. Used ONLY when action is 'add_note'." },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Noting that down...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "action", "statusMessage"]
    },
    async handler(params: { ProcessId: string, action: string, note: string, statusMessage: string }): Promise<string> {
        // emitLog(`MemoryScratchpadTool (Action: ${params.action})`, 'tool_call', 'MemoryScratchpadTool');
        emitAgentMessage(params.statusMessage, 'system');
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        if (params.action === "add_note") {
            if (!params.note) return "Error: note is required for 'add_note' action.";
            state.globalNotes.push(params.note);
            return `Note recorded successfully. Current notes:\n- ${state.globalNotes.join('\n- ')}`;
        }

        if (state.globalNotes.length === 0) return "Scratchpad is empty.";
        return `🧠 Persistent Notes & Thoughts:\n- ${state.globalNotes.join('\n- ')}`;
    }
});

const CreateTodoListTool = ({
    description: "Creates the To-Do list, replacing any existing list. Use this once after the scope of work is known.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            todoList: {
                type: "array",
                description: "The full list of tasks.",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "number" },
                        title: { type: "string", description: "Task description, e.g. 'Organize .pdf files'" },
                        status: { type: "string", enum: ["not-started", "in-progress", "completed", "failed", "blocked"] },
                        notes: { type: "string", description: "Any notes for this task." },
                        extensionList: {
                            type: "array",
                            description: "Include list of extensions for the task to be organized. eg : ['.pdf', '.docx', '.txt']",
                            items: {
                                type: "string",
                                description: "extension to be organized, eg: .pdf"
                            }
                        }
                    },
                    required: ["id", "title", "status", "extensionList"]
                }
            },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Creating a todo list for your files...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "todoList", "statusMessage"]
    },
    async handler(params: { ProcessId: string, todoList: any, statusMessage: string }): Promise<string> {
        // emitLog(`CreateTodoListTool`, 'tool_call', 'CreateTodoListTool');
        emitAgentMessage(params.statusMessage, 'system');
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        if (!params.todoList) return "Error: todoList is required.";
        state.todoList = params.todoList as any[];
        emitAgentMessage(`Created ${state.todoList.length} task${state.todoList.length === 1 ? '' : 's'}: ${state.todoList.map(t => t.title).join(', ')}`, 'task_update');
        emitTodoUpdate(state.todoList);

        return JSON.stringify({ todoList: state.todoList });
    }
});

const ViewTodoListTool = ({
    description: "View the current To-Do list with all details.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Checking your task list...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "statusMessage"]
    },
    async handler(params: { ProcessId: string, statusMessage: string }): Promise<string> {
        emitAgentMessage(params.statusMessage, 'agent');
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        if ((!state.todoList || state.todoList.length === 0) && state.globalNotes.length === 0) return "Todo list and notes are empty.";

        return JSON.stringify({
            globalNotes: state.globalNotes,
            todoList: state.todoList
        });
    }
});

const UpdateTodoListTool = ({
    description: "Update one or more tasks in the To-Do list and return the updated task details.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            updates: {
                type: "array",
                description: "Provide one or more updates to apply, each identifying a task by id.",
                items: {
                    type: "object",
                    properties: {
                        taskId: { type: "number", description: "The ID of the task to update." },
                        status: { type: "string", enum: ["not-started", "in-progress", "completed", "failed", "blocked"], description: "The new status for this task." },
                        notes: { type: "string", description: "Optional notes for this task." }
                    },
                    required: ["taskId", "status"]
                }
            },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Updating your task list...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "updates", "statusMessage"]
    },
    async handler(params: { ProcessId: string, updates: { taskId: number, status: string, notes?: string }[], statusMessage: string }): Promise<string> {
        emitAgentMessage(params.statusMessage, 'system');
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        if (!params.updates || params.updates.length === 0) return "Error: updates is required.";

        let updatedTask: any = null;
        for (const update of params.updates) {
            const task = state.todoList.find(t => t.id === update.taskId);
            if (!task) return `Error: Task with id ${update.taskId} not found.`;
            task.status = update.status as any;
            if (update.notes) task.notes = update.notes;
            updatedTask = { ...task };
            emitAgentMessage(`${task.title} → ${update.status}`, 'task_update', `task_${params.ProcessId}_${update.taskId}`);
        }

        emitTodoUpdate(state.todoList);

        return JSON.stringify({
            updatedTask,
            status: updatedTask?.status ?? null
        });
    }
});


export {
    CreateTodoListTool,
    ViewTodoListTool,
    UpdateTodoListTool,
    MemoryScratchpadTool
};

export const PlanningTools = {
    GetFolderSummaryTool,
    PresentScopeSelectionTool,
    CreateTodoListTool,
    ViewTodoListTool,
    UpdateTodoListTool,
    MemoryScratchpadTool,
    HandOffToCategorizationAgent,
    ErrorEncountered
};