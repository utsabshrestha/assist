import * as fs from 'fs/promises';
import * as path from 'path';
import { defineChatSessionFunction } from 'node-llama-cpp';
import { fileUtil } from '../src/utils/fileUtility.js';
import { workerAgent } from './workerAgent.js';
import { fileAgentRecord, fileAgentState } from '../src/state/fileAgentState.js';
import { analysisWorkerTools, moveWorkerTools } from './fileTools.js';
import {
    analysisWorkerSystemPrompt,
    moveWorkerSystemPrompt,
    moveWorkerUserPrompt
} from '../src/prompt/fileAgent.js';

const analyzeFolder = defineChatSessionFunction({
        description: "Spawns an analysis worker that investigates all files in the given folder. The worker autonomously pages through files in batches and returns a plain-text summary. Call this once after receiving the folder path from the user.",
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
            console.log(`\x1b[95m[Master Tool]\x1b[0m analyzeFolder → ${params.path}`);
            try {

                const state = fileAgentRecord[params.ProcessId];
                if (!state) return "Error: Invalid ProcessId.";

                state.workspacePath = params.path;
                const userPrompt = `ProcessId: ${params.ProcessId} \n\n Begin analysis now. Start by calling checkFolder.`;

                const summary = await workerAgent.getWorkerAgentWithFunctionsReact(
                    analysisWorkerSystemPrompt,
                    userPrompt,
                    analysisWorkerTools,
                    "AnalysisWorker"
                );

                const directories = await getAllDirectories(state.workspacePath, state.workspacePath);
                const folderSummary = `List of folders found in this workspace(${state.workspacePath}) : \n ${directories.join('\n')}`

                return `${summary} \n\n ${folderSummary}`;
            } catch (e: any) {
                return `Error during analysis: ${e.message}`;
            }
        }
    });

    const getAllDirectories = async (dirPath: string, basePath: string = ''): Promise<string[]> => {
                    let dirs: string[] = [];
                    const entries = await fs.readdir(dirPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const relPath = path.join(basePath, entry.name);
                            dirs.push(relPath);
                            const subDirs = await getAllDirectories(path.join(dirPath, entry.name), relPath);
                            dirs = dirs.concat(subDirs);
                        }
                    }
                    return dirs;
                };

    const createFolders = defineChatSessionFunction({
        description: "Creates the given list of absolute folder paths inside the workspace. All paths must be within the workspace established for the current ProcessId session.",
        params: {
            type: "object",
            properties: {
                ProcessId: {
                    type: "string",
                    description: "The process id for the current session, used to validate paths."
                },
                folders: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of absolute folder paths to create."
                }
            },
            required: ["ProcessId", "folders"]
        },
        async handler(params): Promise<string> {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";

            try {
                fileUtil.ValidatePaths(state.workspacePath, params.folders);
            } catch (e: any) {
                return `Error: ${e.message}`;
            }

            const results: string[] = [];
            for (const folderPath of params.folders) {
                try {
                    await fs.mkdir(folderPath, { recursive: true });
                    results.push(`Created: ${folderPath}`);
                } catch (e: any) {
                    results.push(`Failed: ${folderPath} — ${e.message}`);
                }
            }
            return results.join("\n");
        }
    });

    const executeMovePlan = defineChatSessionFunction({
        description: "Spawns a move worker that moves files according to the confirmed plan. The worker autonomously pages through files and moves them one at a time. Call this after createFolders with the plan confirmed by the user.",
        params: {
            type: "object",
            properties: {
                ProcessId: {
                    type: "string",
                    description: "The process id for the current session."
                },
                instruction: {
                    type: "string",
                    description: "Clear description of how files should be categorized and moved, matching the plan confirmed by the user."
                },
                folders: {
                    type: "string",
                    description: "Pipe-separated list of absolute destination folder paths that were created (e.g. '/foo/Images|/foo/Docs')."
                }
            },
            required: ["ProcessId", "instruction", "folders"]
        },
        async handler(params): Promise<string> {
            console.log(`\x1b[95m[Master Tool]\x1b[0m executeMovePlan for ProcessId: ${params.ProcessId}`);

            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";

            // Reset cursor so move worker starts from the beginning of the file list
            state.lastReadInd = 0;

            const folderList = params.folders.split("|").map(f => `- ${f.trim()}`).join("\n");

            const userPrompt = moveWorkerUserPrompt(
                params.ProcessId,
                state.workspacePath,
                params.instruction,
                folderList
            );

            try {
                const summary = await workerAgent.getWorkerAgentWithFunctionsReact(
                    moveWorkerSystemPrompt,
                    userPrompt,
                    moveWorkerTools,
                    "MoveWorker"
                );
                return summary;
            } catch (e: any) {
                return `Error during move execution: ${e.message}`;
            }
        }
    });

    const finalSummary = defineChatSessionFunction({
        description: "Provides the final summary of how many files were moved and how many files are remainning.",
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
            required: ["ProcessId"]
        },
        async handler(params): Promise<string> {
            console.log(`\x1b[95m[Master Tool]\x1b[0m finalSummary → ${params.path}`);
            try {
                const state = fileAgentRecord[params.ProcessId];
                if (!state) return "Error: Invalid ProcessId.";
                if (!state.workspacePath) return "Error: workspacePath not set in state.";

                const fileMoved = state.fileListData.filter(file => file.status == true);
                const fileNotMoved = state.fileListData.filter(file => file.status == false);
                
                const fileNotMovedList = fileNotMoved.slice(0, 10).map( val =>  `${val.fileName} | Type: ${val.ext}`).join(" , ")

                return JSON.stringify({
                    TotalFilesCount: state.fileListData.length,
                    TotalFilesMoved: fileMoved.length,
                    RemainingFiles: fileNotMoved.length,
                    RemainingFilesList: fileNotMovedList,
                    message: "Call analyzeFolder if you need more information on the remaining files."
                });
            } catch (e: any) {
                return `Error during provideing final summary: ${e.message}`;
            }
        }
    });
export const fileOrgMastertools = { analyzeFolder, createFolders, executeMovePlan, finalSummary};
