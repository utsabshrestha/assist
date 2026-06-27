
/**
 * Categorization Agent — Categorization Agent tool set.
 *
 * Responsibilities: read the todo list, run the appropriate categorization
 * worker for each task, update task statuses, then hand off to Execution Agent 3.
 *
 */


import { OpenAISession } from "../src/workerAgent.js";

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileAgentRecord, fileAgentState, fileStatus } from '../src/state/fileAgentState.js';
import type { TodoStatus } from '../src/state/fileAgentState.js';
import { LLMService } from '../src/LLMService.js';
import { documentWorkerAgentSystemPrompt, nonDocumentWorkerAgentSystemPrompt, imageWorkerAgentSystemPrompt } from '../src/prompt/fileAgent.js';
import { GetCategoriesoffilesofspecificextension, GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions, workerCompletionStatus, FinalizeThefolderforImages, FinalizeThefolderforNonDocuments, GetCategoriesForNonDocuments, UpdateCategoryNameForNonDocumentsTool, UpdateCategoryNameForImagesTool, PresentDocumentFolderPlanTool, PresentImageFolderPlanTool, PresentNonDocumentFolderPlanTool } from './fileCategorizationTools.js';
import { ERROR_ENCOUNTERED, ErrorEncountered, HandOffToExecutionAgent } from '../tools/pipelineTools.js';
import { ManageTodoListTool, MemoryScratchpadTool} from '../tools/planningAgentTools.js';
import { emitLog, emitTodoUpdate, emitAgentMessage } from '../electron/ipcBridge.js';

const DocumentCategorizationAgent = ({
    description: "Spins up an Agent to virtually organize document file extension(s). It organized Documents extensions such as (.pdf, .docx, .doc, .txt, .xlsx, .xls, .csv, .ppt, .pptx, .json, .md).",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            TaskId: { type: "number", description: "The Task Id of the todo List"},
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Starting to organize your documents...'. This will be shown directly to the user."
            }
        },
        required: ["TaskId", "ProcessId", "statusMessage"]
    },
    async handler(params: {ProcessId: string, TaskId: number, statusMessage: string}): Promise<string> {
        emitLog(`DocumentCategorizationAgent for Task : ${params.TaskId}`, 'tool_call', 'DocumentCategorizationAgent');
        emitAgentMessage(params.statusMessage);

        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const task = state.todoList.find(t => t.id === params.TaskId);
        const extensions: string[] = task ? task.extensionList : [];

        // Initialize per-extension sub-progress tracking for the UI — never authored by the LLM.
        if (task) {
            task.subTasks = extensions.map(ext => ({ extension: ext, status: 'not-started' as TodoStatus }));
            emitTodoUpdate(state.todoList);
        }

        const llmService = await LLMService.getInstance();
        const results : Record<string, string> = {};
        for(const extension of extensions){
            const groupId = `ext_${params.ProcessId}_${params.TaskId}_${extension}`;
            const subTask = task?.subTasks?.find(s => s.extension === extension);
            if (subTask) {
                subTask.status = 'in-progress';
                emitTodoUpdate(state.todoList);
                emitAgentMessage(`${extension} → in-progress`, 'task_update', groupId);
            }

            const result = await CategorizedDocument(params.ProcessId, extension, llmService);
            if(result.includes(ERROR_ENCOUNTERED)){
                if (subTask) {
                    subTask.status = 'failed';
                    emitTodoUpdate(state.todoList);
                    emitAgentMessage(`${extension} → failed`, 'task_update', groupId);
                }
                return `Error encountered during categorizing document of type ${extension}`;
            }
            if (subTask) {
                subTask.status = 'completed';
                emitTodoUpdate(state.todoList);
                emitAgentMessage(`${extension} → completed`, 'task_update', groupId);
            }
            results[extension] = result;
        }
        return JSON.stringify(results);
    }
});

async function CategorizedDocument(processId : string, extension : string, llmService : LLMService) : Promise<string> {
    const state = fileAgentRecord[processId];
    if (!state) return "Error: Invalid ProcessId.";
    
    return new Promise(async (resolve) => {
        try{
            const session = new OpenAISession(llmService, documentWorkerAgentSystemPrompt(extension, state.workspacePath));
            const MAX_AUTO_CONTINUE = 5;
            let autoContinueCount = 0;

            const runLoop = async () => {
                if (++autoContinueCount > MAX_AUTO_CONTINUE) {
                    emitLog(`Docs Worker (${extension}) stalled without finalizing — aborting.`, 'error', 'DocWorkerAgent');
                    resolve(ERROR_ENCOUNTERED);
                    return;
                }

                let response = '';
                try {
                    response = await session.prompt('Continue with the next step.', { functions: { GetCategoriesoffilesofspecificextension, PresentDocumentFolderPlanTool, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions, ErrorEncountered }, forceToolUse: true });
                    emitLog(response, 'info', 'DocWorkerAgent');
                } catch (e: any) {
                    emitLog(`Error: ${e.message}`, 'error', 'DocWorkerAgent');
                }

                if (workerCompletionStatus[`${processId}_${extension.replaceAll(".", "")}`]) {
                    resolve(`Successfully Organized.`);
                    return;
                }
                if (response.includes(ERROR_ENCOUNTERED)) {
                    resolve(ERROR_ENCOUNTERED);
                    return;
                }
                await runLoop();
            };

            const response = await session.prompt(`Start organizing ${extension} files for ProcessId: ${processId} and path: ${state.workspacePath}`,
                { functions: { GetCategoriesoffilesofspecificextension, PresentDocumentFolderPlanTool, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions, ErrorEncountered }, forceToolUse: true });
            emitLog(response, 'info', 'DocWorkerAgent');

            if (workerCompletionStatus[`${processId}_${extension.replaceAll(".","")}`]) {
                resolve(`Successfully Organized.`);
                return;
            }
            if(response.includes(ERROR_ENCOUNTERED)){
                resolve(ERROR_ENCOUNTERED);
                return;
            }
            await runLoop();
    
        } catch(ex){
            resolve("Error while organizing");
        }
    });
}

const NonDocumentCategorizationAgent = ({
    description: "Spins up an worker Agent to virtually organize multiple non-document file extensions. Non-documents extensions it supports are (.zip, .rar, .7z, .tar, .gz, .mp4, .mov, .avi, .mkv, .wmv, .flv, .webm, .mp3, .wav, .aac, .flac, .ogg, .m4a, .htm, .xml, .exe, .dmg, .deb, .rpm, .apk, .ipa, .jar, .war, .ear, .py, .js, .ts, .java, .cpp, .cs, .php, .rb, .go, .swift, .kt, .rs, .html, .htm, .xml, .exe, .dmg, .deb, .rpm, .apk, .ipa, .jar, .war, .ear, .py, .js, .ts, .java, .cpp, .cs, .php, .rb, .go, .swift, .kt, .rs, .pynb).",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            TaskId: { type: "number", description: "The Task Id of the todo List"},
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Starting to organize your other files...'. This will be shown directly to the user."
            }
        },
        required: ["TaskId", "ProcessId", "statusMessage"]
    },
    async handler(params: {ProcessId: string, TaskId: number, statusMessage: string}): Promise<string> {
        emitLog(`NonDocumentCategorizationAgent for Task ${params.TaskId}`, 'tool_call', 'NonDocumentCategorizationAgent');
        emitAgentMessage(params.statusMessage);

        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const llmService = await LLMService.getInstance();

        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, nonDocumentWorkerAgentSystemPrompt(state.workspacePath, params.TaskId));
            const MAX_AUTO_CONTINUE = 5;
            let autoContinueCount = 0;

            const runLoop = async () => {
                if (++autoContinueCount > MAX_AUTO_CONTINUE) {
                    emitLog('Non-Document Worker stalled without finalizing — aborting.', 'error', 'NonDocWorkerAgent');
                    resolve('Error encountered while organizing non documents');
                    return;
                }

                let response = '';
                try {
                    response = await session.prompt('Continue with the next step.', { functions: {GetCategoriesForNonDocuments, PresentNonDocumentFolderPlanTool, FinalizeThefolderforNonDocuments, UpdateCategoryNameForNonDocumentsTool, ErrorEncountered }, forceToolUse: true });
                    emitLog(response, 'info', 'NonDocWorkerAgent');
                } catch (e: any) {
                    emitLog(`Error: ${e.message}`, 'error', 'NonDocWorkerAgent');
                }

                if (workerCompletionStatus[`${params.ProcessId}_TaskId${params.TaskId}`]) {
                    resolve(`Non-document organizing Task is complete. Continue with next steps. You can update the status in todo list for this task`);
                    return;
                }
                if(response.includes(ERROR_ENCOUNTERED)){
                    resolve('Error encountered while organizing non documents');
                    return;
                }
                await runLoop();
            };

            const response = await session.prompt(`Please start the process. ProcessId = ${params.ProcessId}, TaskId = ${params.TaskId}`,
            { functions: { GetCategoriesForNonDocuments, PresentNonDocumentFolderPlanTool, FinalizeThefolderforNonDocuments, UpdateCategoryNameForNonDocumentsTool, ErrorEncountered }, forceToolUse: true });
            emitLog(response, 'info', 'NonDocWorkerAgent');

            if (workerCompletionStatus[`${params.ProcessId}_TaskId${params.TaskId}`]) {
                resolve(`Non-document organizing Task is complete. You can update the status in todo list for this task`);
                return;
            }
            if(response.includes(ERROR_ENCOUNTERED)){
                resolve('Error encountered while organizing non documents');
                return;
            }
            await runLoop();
        });
    }
});

const ImageCategorizationAgent = ({
    description: "Spins up a vision-powered worker Agent to organize image file extensions. It uses the LLM's vision capability to describe each image, clusters descriptions by similarity, and proposes content-based folder names. Images it supports are (.jpg, .png, .jpeg, .webp, .gif).",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            TaskId: { type: "number", description: "The Task Id of the todo List"},
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Starting to organize your images...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "TaskId", "statusMessage"]
    },
    async handler(params: {ProcessId: string, TaskId: number, statusMessage: string}): Promise<string> {
        emitLog(`ImageCategorizationAgent for Task : ${params.TaskId}`, 'tool_call', 'ImageCategorizationAgent');
        emitAgentMessage(params.statusMessage);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        const llmService = await LLMService.getInstance();

        const extensions: string[] = state.todoList
                        .filter(x => x.id === params.TaskId)
                        .flatMap(todoItem => todoItem.extensionList);

        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, imageWorkerAgentSystemPrompt(extensions, state.workspacePath, params.TaskId));
            const MAX_AUTO_CONTINUE = 5;
            let autoContinueCount = 0;

            const runLoop = async () => {
                if (++autoContinueCount > MAX_AUTO_CONTINUE) {
                    emitLog('Image Worker stalled without finalizing — aborting.', 'error', 'ImageWorkerAgent');
                    resolve('Error encountered while organizing images');
                    return;
                }

                let response = '';
                try {
                    response = await session.prompt('Continue with the next step.', { functions: { GetCategoriesOfImages, PresentImageFolderPlanTool, UpdateCategoryNameForImagesTool, FinalizeThefolderforImages, ErrorEncountered  }, forceToolUse: true });
                    emitLog(response, 'info', 'ImageWorkerAgent');
                } catch (e: any) {
                    emitLog(`Error: ${e.message}`, 'error', 'ImageWorkerAgent');
                }
                if(response.includes(ERROR_ENCOUNTERED)){
                    resolve('Error encountered while organizing images');
                    return;
                }
                const allDone = extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`]);
                if (allDone) {
                    resolve(`Auto-finalized: Image organizing worker finished for ${extensions.join(', ')}. You can update the status in todo list for this task.`);
                    return;
                }
                await runLoop();
            };

            const response = await session.prompt(`Start organizing these image extensions: [${extensions.join(', ')}] for ProcessId: ${params.ProcessId}, TaskId: ${params.TaskId} and path: ${state.workspacePath}`,
            { functions: { GetCategoriesOfImages, PresentImageFolderPlanTool, UpdateCategoryNameForImagesTool, FinalizeThefolderforImages, ErrorEncountered  }, forceToolUse: true });

            emitLog(response, 'info', 'ImageWorkerAgent');
            if(response.includes(ERROR_ENCOUNTERED)){
                resolve('Error encountered while organizing images');
                return;
            }
            const allDone = extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`]);
            if (allDone) {
                resolve(`Auto-finalized: Image organizing worker finished for ${extensions.join(', ')}. You can update the status in todo list for this task.`);
                return;
            }
            await runLoop();
        });
    }
});

export const CategorizationTools = {
    ManageTodoListTool,
    MemoryScratchpadTool,
    DocumentCategorizationAgent,
    NonDocumentCategorizationAgent,
    ImageCategorizationAgent,
    HandOffToExecutionAgent,
    ErrorEncountered
};


