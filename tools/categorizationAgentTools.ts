
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
import * as readline from 'readline';
import { fileAgentRecord, fileAgentState, fileStatus } from '../src/state/fileAgentState.js';
import { LLMService } from '../src/LLMService.js';
import { documentWorkerAgentSystemPrompt, nonDocumentWorkerAgentSystemPrompt, imageWorkerAgentSystemPrompt } from '../src/prompt/fileAgent.js';
import { GetCategoriesoffilesofspecificextension, GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions, workerCompletionStatus, FinalizeThefolderforImages, FinalizeThefolderforNonDocuments, GetCategoriesForNonDocuments, UpdateCategoryNameForNonDocumentsTool } from './fileCategorizationTools.js';
import { HandOffToExecutionAgent } from '../tools/pipelineTools.js';
import { ManageTodoListTool, MemoryScratchpadTool} from '../tools/planningAgentTools.js';
import { stat } from "fs";

const DocumentCategorizationAgent = ({
    description: "Spins up an Agent to virtually organize document file extension(s). It organized Documents extensions such as (.pdf, .docx, .doc, .txt, .xlsx, .xls, .csv, .ppt, .pptx, .json, .md).",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            TaskId: { type: "number", description: "The Task Id of the todo List"}
        },
        required: ["TaskId", "ProcessId"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m DocumentCategorizationAgent for Task : ${params.TaskId}`);
        
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        
        const extensions: string[] = state.todoList
                        .filter(x => x.id === params.TaskId)
                        .flatMap(todoItem => todoItem.extensionList);

        const llmService = await LLMService.getInstance();
        const results : Record<string, string> = {};
        for(const extension of extensions){
            
            const resutl = await CategorizedDocument(params.ProcessId, extension, llmService);
            results[extension] = resutl;
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
    
                        if (workerCompletionStatus[`${processId}_${extension.replaceAll(".", "")}`]) {
                            // session discarded
                            resolve(`Sucessfully Organized.`);
                            return;
                        }
                        runLoop();
                    });
                };
    
                const response = await session.prompt(`Start organizing ${extension} files for ProcessId: ${processId} and path: ${state.workspacePath}`, 
                    { functions: { GetCategoriesoffilesofspecificextension, UpdateCategoryNameTool, FinalizeThefolderforthefilesforEachExtensions } });
                console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
                if (workerCompletionStatus[`${processId}_${extension.replaceAll(".","")}`]) {
                    // session discarded
                    resolve(`Sucessfully Organized.`);
                    return;
                }
                runLoop();
        
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
            TaskId: { type: "number", description: "The Task Id of the todo List"}
        },
        required: ["path", "TaskId", "ProcessId"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m NonDocumentCategorizationAgent for Task ${params.TaskId}`);

        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        // const extensions: string[] = state.todoList
        //                 .filter(x => x.id === params.TaskId)
        //                 .flatMap(todoItem => todoItem.extensionList);

        const llmService = await LLMService.getInstance();

        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, nonDocumentWorkerAgentSystemPrompt(state.workspacePath));
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
                        resolve("Non-document organizing Task is complete. Continue with next steps. You can update the status in todo list for this task");
                        return;
                    }
                    try {
                        const response = await session.prompt(answer, { functions: {GetCategoriesForNonDocuments, FinalizeThefolderforNonDocuments, UpdateCategoryNameForNonDocumentsTool } });
                        console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
                    } catch (e: any) {
                        console.log(`\x1b[91mError:\x1b[0m ${e.message}`);
                    }

                    if (workerCompletionStatus[`${params.ProcessId}_TaskId${params.TaskId}`]) {
                        // session discarded
                        resolve(`Non-document organizing Task is complete.  Continue with next steps.  You can update the status in todo list for this task`);
                        return;
                    }
                    runLoop();
                });
            };

            const response = await session.prompt(`Please start the process. ProcessId = ${params.ProcessId}, TaskId = ${params.TaskId}`, 
            { functions: { GetCategoriesForNonDocuments, FinalizeThefolderforNonDocuments, UpdateCategoryNameForNonDocumentsTool } });
            console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);

            if (workerCompletionStatus[`${params.ProcessId}_TaskId${params.TaskId}`]) {
                // session discarded
                resolve(`Non-document organizing Task is complete.  You can update the status in todo list for this task`);
                return;
            }
            runLoop();
        });
    }
});

const ImageCategorizationAgent = ({
    description: "Spins up a vision-powered worker Agent to organize image file extensions. It uses the LLM's vision capability to describe each image, clusters descriptions by similarity, and proposes content-based folder names. Images it supports are (.jpg, .png, .jpeg, .webp, .gif).",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session, provided by the user." },
            TaskId: { type: "number", description: "The Task Id of the todo List"}
        },
        required: ["path", "ProcessId", "TaskId"]
    },
    async handler(params): Promise<string> {
        console.log(`\x1b[95m[Master Tool]\x1b[0m ImageCategorizationAgent for Task : ${params.TaskId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        const llmService = await LLMService.getInstance();

        const extensions: string[] = state.todoList
                        .filter(x => x.id === params.TaskId)
                        .flatMap(todoItem => todoItem.extensionList);

        return new Promise(async (resolve) => {
            const session = new OpenAISession(llmService, imageWorkerAgentSystemPrompt(extensions, state.workspacePath));
            const runLoop = () => {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl.question("\x1b[94mUser (Images):\x1b[0m ", async (answer) => {
                    rl.close();
                    try {
                        const response = await session.prompt(answer, { functions: { GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforImages } });
                        console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
                    } catch (e: any) {
                        console.log(`\x1b[91mError:\x1b[0m ${e.message}`);
                    }
                    const allDone = extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`]);
                    if (allDone) {
                        resolve(`Auto-finalized: Image organizing worker finished for ${extensions.join(', ')}. You can update the status in todo list for this task.`);
                        return;
                    }
                    runLoop();
                });
            };
            const response = await session.prompt(`Start organizing these image extensions: [${extensions.join(', ')}] for ProcessId: ${params.ProcessId} and path: ${state.workspacePath}`, 
            { functions: { GetCategoriesOfImages, UpdateCategoryNameTool, FinalizeThefolderforImages } });

            console.log(`\x1b[92mAssistant:\x1b[0m ${response}`);
            const allDone = extensions.every(ext => workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`]);
            if (allDone) {
                resolve(`Auto-finalized: Image organizing worker finished for ${extensions.join(', ')}. You can update the status in todo list for this task.`);
                return;
            }
            runLoop();
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
};


