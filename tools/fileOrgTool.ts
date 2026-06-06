import { OpenAISession } from "./workerAgent.js";

import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
// import { defineChatSessionFunction, getLlama, LlamaJsonSchemaGrammar } from 'node-llama-cpp';
import { fileUtil } from '../src/utils/fileUtility.js';
import { workerAgent } from './workerAgent.js';
import { fileAgentRecord, fileAgentState, fileStatus } from '../src/state/fileAgentState.js';
import { LLMService } from '../src/LLMService.js';
import { FileClassificationTool } from './fileClassificationTool.js';
import { FileContentExtractor } from '../src/utils/fileContentExtractor.js';
import { documentWorkerAgentSystemPrompt, nonDocumentWorkerAgentSystemPrompt, imageWorkerAgentSystemPrompt } from '../src/prompt/fileAgent.js';
import { stat } from 'fs';
import { GetCategoriesoffilesofspecificextension, GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions, workerCompletionStatus } from './fileOrgWorkerTool.js';

const GetFolderSummaryTool = ({
    description: "This tool will provide total number of files in the folder, list of different file extensions, number of files per extensions, total size, list of directories inside the folder.",
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
            }
        },
        required: ["path", "ProcessId"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m getFolderSummary → ${params.path}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        state.workspacePath = params.path;

        try {
            await fs.access(params.path);
        } catch {
            return `Error: Workspace folder does not exist: '${params.path}'. Folders must be exist to organize the files.`;
        }

        try {
            const entries = await fs.readdir(state.workspacePath, { withFileTypes: true });
            const files = entries
                .filter((e: fs.Dirent) => e.isFile())
                .sort((a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name));
            let totalFileSize: number = 0;

            await Promise.all(files.map(async (file: fs.Dirent) => {
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
                    console.log(`Error encountered while listing files ${ex}`)
                }
            }));

            const fileCountByExt: Record<string, number> = {};
            Object.entries(state.fileByExtension).forEach(([extensions, list]) => {
                fileCountByExt[extensions] = list.length;
            })

            const extensions: string[] = Array.from(new Set(
                files.map((f: fs.Dirent) => path.extname(f.name).toLowerCase()).filter((e: string) => e !== '')
            ));

            const directories = await getAllDirectories(state.workspacePath, state.workspacePath, 0);


            state.filesCount = files.length;
            state.extensions = extensions;
            state.lastReadInd = 0;

            return JSON.stringify({
                TotalFileCount: files.length,
                TotalFileSize: `${(totalFileSize / 1024).toFixed(2)} MB`,
                extensionsFound: extensions.join(", "),
                FileCountByExtension: fileCountByExt,
                directories: directories,
                message: "Call GetCategoricalSummaryOfFilesByExtension to get summary of files of particular file extensions."
            });
        } catch (e: any) {
            return `We have encountered Error reading folder: ${e.message}, please report to the user immediately.`;
        }
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

const getFinalPlanConfirmation = ({
    description: "Prints the complete proposed file movement plan to the console and asks the user for confirmation. Call this ONLY after finalizing all folders for all extensions. The LLM will receive the user's response to either proceed or make changes.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            }
        },
        required: ["ProcessId"]
    },
    async handler(params): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        // Group all finalized files by destination folder
        let plan: Record<string, string[]> = {};
        let unassignedCount = 0;

        for (const files of Object.values(state.fileByExtension)) {
            for (const file of files) {
                if (file.folderPath) {
                    if (!plan[file.folderPath]) plan[file.folderPath] = [];
                    plan[file.folderPath].push(file.fileName);
                } else {
                    unassignedCount++;
                }
            }
        }

        // Print beautifully to the user's console directly (bypassing the LLM context limit)
        console.log("\n========================================================");
        console.log("                📦 PROPOSED MOVEMENT PLAN               ");
        console.log("========================================================");

        for (const [folder, fileNames] of Object.entries(plan)) {
            console.log(`\n📁 Destination: \x1b[36m${folder}\x1b[0m`);
            const displayFiles = fileNames.slice(0, 5);
            displayFiles.forEach(f => console.log(`   📄 ${f}`));
            if (fileNames.length > 5) {
                console.log(`   ... and \x1b[33m${fileNames.length - 5} more files\x1b[0m.`);
            }
        }

        if (unassignedCount > 0) {
            console.log(`\n⚠️  WARNING: \x1b[31m${unassignedCount} files currently have NO destination folder assigned.\x1b[0m`);
        }
        console.log("========================================================\n");

        // Pause the tool execution to ask for user input via terminal
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            rl.question("\x1b[95mDo you confirm this plan? [Type 'confirm' to proceed, or type changes you want]: \x1b[0m", (answer) => {
                rl.close();
                const trimmed = answer.trim().toLowerCase();
                if (trimmed === 'confirm' || trimmed === 'y' || trimmed === 'yes') {
                    state.planConfirmed = true;
                    resolve("User confirmed the plan exactly as is. You may proceed to create the folders and execute the move plan.");
                } else {
                    state.planConfirmed = false;
                    resolve(`User did not confimed the plan. This is what user said about the plan : "${answer}". Please adjust the categories/folders as requested by the user using the Finalize tool again, or respond accordingly.`);
                }
            });
        });
    }
});

const Executetheprocess = ({
    description: "Executes the finalized file movement plan. Only execute this tool if user explicitly confirmed the plan. This tool will Automatically creates all required folders and moves the files. It handles errors gracefully without crashing and returns a comprehensive summary of successes and any errors.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            },
            path: {
                type: "string",
                description: "The absolute path of the workspace where operations are being performed."
            }
        },
        required: ["ProcessId", "path"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m Executetheprocess → ${params.path}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        // Hard stop if plan hasn't been confirmed explicitly
        if (!state.planConfirmed) {
            return "Error: You CANNOT execute the process because the user has not confirmed the plan. You must use getFinalPlanConfirmation and receive explicit user approval first.";
        }

        // Security check: ensure LLM isn't trying to operate on a different path
        if (path.resolve(params.path) !== path.resolve(state.workspacePath)) {
            return `Error: The path provided ('${params.path}') does not match the established workspace path ('${state.workspacePath}'). Operations are only allowed within the original workspace.`;
        }

        const foldersToCreate = new Set<string>();
        const filesToMove: fileStatus[] = [];

        // Gather all destinations based on the finalized state
        for (const file of state.fileListData) {
            if (file.folderPath && !file.status) {
                foldersToCreate.add(file.folderPath);
                filesToMove.push(file);
            }
        }

        if (filesToMove.length === 0) {
            return "No files pending to be moved. Either folders were not finalized or files have already been moved.";
        }

        const results = {
            foldersCreated: 0,
            folderErrors: [] as string[],
            filesMoved: 0,
            fileErrors: [] as string[]
        };

        const resolvedWorkspacePath = path.resolve(state.workspacePath);

        // 1. Safely Create Folders
        for (const folder of foldersToCreate) {
            if (!path.resolve(folder).startsWith(resolvedWorkspacePath)) {
                results.folderErrors.push(`Failed to create folder ${folder}: Security Error - Path is outside workspace.`);
                continue;
            }
            try {
                await fs.mkdir(folder, { recursive: true });
                results.foldersCreated++;
            } catch (e: any) {
                // Ignore "folder already exists" (EEXIST) errors
                if (e.code !== 'EEXIST') {
                    results.folderErrors.push(`Failed to create folder ${folder}: ${e.message}`);
                }
            }
        }

        // 2. Safely Move Files
        for (const file of filesToMove) {
            try {
                const destPath = path.join(file.folderPath, file.fileName);
                if (!path.resolve(destPath).startsWith(resolvedWorkspacePath)) {
                    results.fileErrors.push(`Failed to move ${file.fileName}: Security Error - Destination path is outside workspace.`);
                    continue;
                }
                await fs.rename(file.filePath, destPath);
                // Update state upon success
                file.filePath = destPath;
                file.status = true;
                results.filesMoved++;
            } catch (e: any) {
                results.fileErrors.push(`Failed to move ${file.fileName}: ${e.message}`);
            }
        }

        let summary = `Process Execution Completed for ${filesToMove.length} total files.\n`;
        summary += `- Folders created successfully: ${results.foldersCreated}\n`;
        if (results.folderErrors.length > 0) {
            summary += `- Folder Creation Errors (${results.folderErrors.length}):\n  ${results.folderErrors.slice(0, 5).join("\n  ")}${results.folderErrors.length > 5 ? '\n  ...and more.' : ''}\n`;
        }
        summary += `- Files moved successfully: ${results.filesMoved}\n`;
        if (results.fileErrors.length > 0) {
            summary += `- File Move Errors (${results.fileErrors.length}):\n  ${results.fileErrors.slice(0, 5).join("\n  ")}${results.fileErrors.length > 5 ? '\n  ...and more.' : ''}\n`;
        } else {
            summary += `- File Move Errors: 0\n`;
        }

        console.log("\x1b[32mExecution complete!\x1b[0m", { folders: results.foldersCreated, moved: results.filesMoved, errors: results.fileErrors.length });
        return summary;
    }
});

const DocumentCategorizationAgent = ({
    description: "Spins up an Agent to virtually organize specific document file extension(s) (pdf, docx, doc, txt, xlsx, xls, csv, ppt, pptx, json, md). It will not physically move the file, but make a plan to organize them by creating categories and suggest a folder name for each category. It will ask for user confirmation for the folder name for each category.",
    params: {
        type: "object",
        properties: {
            path: { type: "string", description: "Absolute path of the folder to analyze." },
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            extension: { type: "string", description: "The specific document file extension to organize (e.g. '.pdf', '.docx')." }
        },
        required: ["path", "ProcessId", "extension"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m DocumentCategorizationAgent for ${params.extension}`);

        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const llmService = await LLMService.getInstance();

        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, documentWorkerAgentSystemPrompt(params.extension, state.workspacePath));
            const runLoop = () => {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl.question("\x1b[94mUser (Docs):\x1b[0m ", async (answer) => {
                    rl.close();
                    try {
                        const response = await session.prompt(answer, { functions: { GetCategoriesoffilesofspecificextension, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions } });
                        console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
                    } catch (e: any) {
                        console.log(`\x1b[91mError:\x1b[0m ${e.message}`);
                    }

                    if (workerCompletionStatus[`${params.ProcessId}_${params.extension.replaceAll(".", "")}`]) {
                        // session discarded
                        resolve(`Auto-finalized: Document organizing worker finished for ${params.extension}. You can update the status in todo list for ${params.extension}.`);
                        return;
                    }
                    runLoop();
                });
            };

            const response = await session.prompt(`Start organizing ${params.extension} files for ProcessId: ${params.ProcessId} and path: ${params.path}`, { functions: { GetCategoriesoffilesofspecificextension, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions } });
            console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
            if (workerCompletionStatus[`${params.ProcessId}_${params.extension}`]) {
                // session discarded
                resolve(`Auto-finalized: Document organizing worker finished for ${params.extension}. You can update the status in todo list for ${params.extension}.`);
                return;
            }
            runLoop();
        });
    }
});

const NonDocumentCategorizationAgent = ({
    description: "Spins up an Agent to virtually organize multiple non-document file extensions (e.g. all image types, or all video types together).",
    params: {
        type: "object",
        properties: {
            path: { type: "string", description: "Absolute path of the folder to analyze." },
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            extensions: {
                type: "array",
                items: { type: "string" },
                description: "An array of non-document file extensions to organize together (e.g. ['.jpg', '.png', '.gif'])."
            }
        },
        required: ["path", "ProcessId", "extensions"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m NonDocumentCategorizationAgent for ${params.extensions.join(', ')}`);
        const llmService = await LLMService.getInstance();

        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, nonDocumentWorkerAgentSystemPrompt(params.extensions));



            const runLoop = () => {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl.question("\x1b[94mUser (Docs):\x1b[0m ", async (answer) => {
                    rl.close();
                    const trimmed = answer.trim().toLowerCase();
                    if (trimmed === 'done' || trimmed === 'cancel') {
                        // session discarded
                        resolve("Non-document organizing worker finished. Continue with next steps.");
                        return;
                    }
                    try {
                        const response = await session.prompt(answer, { functions: { FinalizeThefolderforthefilesforEachExtensions, UpdateCategoryNameTool } });
                        console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
                    } catch (e: any) {
                        console.log(`\x1b[91mError:\x1b[0m ${e.message}`);
                    }

                    const allDone = params.extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext}`]);
                    if (allDone) {
                        // session discarded
                        resolve(`Auto-finalized: Non-document organizing worker finished for ${params.extensions.join(', ')}.  You can update the status in todo list for this task`);
                        return;
                    }
                    runLoop();
                });
            };

            const response = await session.prompt(`Start organizing these extensions: ${params.extensions.join(', ')} for ProcessId: ${params.ProcessId} and path: ${params.path}`, { functions: { FinalizeThefolderforthefilesforEachExtensions, UpdateCategoryNameTool } });
            console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);

            const allDone = params.extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext}`]);
            if (allDone) {
                // session discarded
                resolve(`Auto-finalized: Non-document organizing worker finished for ${params.extensions.join(', ')}. You can update the status in todo list for this task`);
                return;
            }
            runLoop();
        });
    }
});


const ImageCategorizationAgent = ({
    description: "Spins up a vision-powered worker to organize image file extensions (e.g. .jpg, .png, .jpeg, .webp, .gif). It uses the LLM's vision capability to describe each image, clusters descriptions by similarity, and proposes content-based folder names.",
    params: {
        type: "object",
        properties: {
            path: { type: "string", description: "Absolute path of the folder to analyze." },
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            extensions: {
                type: "array",
                items: { type: "string" },
                description: "An array of image file extensions to organize together (e.g. ['.jpg', '.png', '.jpeg'])."
            }
        },
        required: ["path", "ProcessId", "extensions"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m ImageCategorizationAgent for ${params.extensions.join(', ')}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        const llmService = await LLMService.getInstance();
        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, imageWorkerAgentSystemPrompt(params.extensions, state.workspacePath));
            const runLoop = () => {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl.question("\x1b[94mUser (Images):\x1b[0m ", async (answer) => {
                    rl.close();
                    try {
                        const response = await session.prompt(answer, { functions: { GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions } });
                        console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
                    } catch (e: any) {
                        console.log(`\x1b[91mError:\x1b[0m ${e.message}`);
                    }
                    const allDone = params.extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`]);
                    if (allDone) {
                        resolve(`Auto-finalized: Image organizing worker finished for ${params.extensions.join(', ')}. You can update the status in todo list for this task.`);
                        return;
                    }
                    runLoop();
                });
            };
            const response = await session.prompt(`Start organizing these image extensions: ${params.extensions.join(', ')} for ProcessId: ${params.ProcessId} and path: ${params.path}`, { functions: { GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions } });
            console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
            const allDone = params.extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`]);
            if (allDone) {
                resolve(`Auto-finalized: Image organizing worker finished for ${params.extensions.join(', ')}. You can update the status in todo list for this task.`);
                return;
            }
            runLoop();
        });
    }
});


const MemoryScratchpadTool = ({
    description: "A secure scratchpad to record your thoughts, specify user constraints, or note down findings. Use 'add_note' to append a note, and 'view' to read all notes.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            action: { type: "string", enum: ["add_note", "view"], description: "Action to perform on scratchpad." },
            note: { type: "string", description: "The content to remember. Used ONLY when action is 'add_note'." }
        },
        required: ["ProcessId", "action"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m MemoryScratchpadTool (Action: ${params.action})`);
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

const ManageTodoListTool = ({
    description: "Manages the To-Do list. Use 'create', 'update_task', or 'view' to track files and processing state.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            action: {
                type: "string",
                enum: ["create", "update_task", "view"],
                description: "The operation to perform. 'create' replaces the list, 'update_task' modifies one item, 'view' returns current status."
            },
            todoList: {
                type: "array",
                description: "Used ONLY when action is 'create'. The full list of tasks.",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "number" },
                        title: { type: "string", description: "Task description, e.g. 'Organize .pdf files'" },
                        status: { type: "string", enum: ["not-started", "in-progress", "completed", "failed", "blocked"] },
                        notes: { type: "string", description: "Optional outcome notes or failure reasons." }
                    },
                    required: ["id", "title", "status"]
                }
            },
            taskId: { type: "number", description: "Used ONLY when action is 'update_task'. The ID of the task to update." },
            status: { type: "string", enum: ["not-started", "in-progress", "completed", "failed", "blocked"], description: "Used ONLY when action is 'update_task'. The new status." },
            notes: { type: "string", description: "Optional notes when updating a task." }
        },
        required: ["ProcessId", "action"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m ManageTodoListTool (Action: ${params.action})`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        if (params.action === "create") {
            if (!params.todoList) return "Error: todoList is required for 'create' action.";
            state.todoList = params.todoList as any[];
        } else if (params.action === "update_task") {
            if (params.taskId === undefined || !params.status) return "Error: taskId and status are required for 'update_task' action.";
            const task = state.todoList.find(t => t.id === params.taskId);
            if (!task) return `Error: Task with id ${params.taskId} not found.`;
            task.status = params.status as any;
            if (params.notes) task.notes = params.notes;
        }

        if ((!state.todoList || state.todoList.length === 0) && state.globalNotes.length === 0) return "Todo list and notes are empty.";

        let summary = "";
        if (state.globalNotes && state.globalNotes.length > 0) {
            summary += "🧠 Persistent Notes & Thoughts:\n- " + state.globalNotes.join('\n- ') + "\n\n";
        }

        summary += "📋 Current Todo List:\n";
        if (state.todoList && state.todoList.length > 0) {
            for (const item of state.todoList) {
                let icon = '⏳';
                if (item.status === 'completed') icon = '✅';
                else if (item.status === 'in-progress') icon = '🔄';
                else if (item.status === 'failed') icon = '❌';
                else if (item.status === 'blocked') icon = '🚧';

                const taskNotes = item.notes ? ` - Notes: ${item.notes}` : "";
                summary += `${icon} [${item.id}] ${item.title} (${item.status})${taskNotes}\n`;
            }
        } else {
            summary += "(Empty list)\n";
        }
        return summary;
    }
});

export const fileOrgMastertools = { MemoryScratchpadTool, ManageTodoListTool, GetFolderSummaryTool, DocumentCategorizationAgent, NonDocumentCategorizationAgent, ImageCategorizationAgent, Executetheprocess, getFinalPlanConfirmation };
