import * as fs from 'fs/promises';
import * as path from 'path';
import { defineChatSessionFunction, getLlama } from 'node-llama-cpp';
import { fileUtil } from '../src/utils/fileUtility.js';
import { workerAgent } from './workerAgent.js';
import { fileAgentRecord, fileAgentState, fileStatus } from '../src/state/fileAgentState.js';
import { analysisWorkerTools, moveWorkerTools } from './fileTools.js';
import {
    analysisWorkerNewSession,
    analysisWorkerSystemPrompt,
    analysisWorkerSystemPrompt2,
    moveWorkerSystemPrompt,
    moveWorkerUserPrompt
} from '../src/prompt/fileAgent.js';
import { LLMService } from '../src/LLMService.js';

const GetCategoricalSummaryOfFilesByExtension = defineChatSessionFunction({
        description: "Spawns an worker agent that analyzes all files by their filenames of given extension, categorize them into a logical category. Send only one extension per call.",
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
                extension:{
                    type: "string",
                    description: "The file extension which you want to get categorical summary of. eg: `.pdf`"
                }
            },
            required: ["path", "ProcessId"]
        },
        async handler(params): Promise<string> {
            console.log(`\x1b[95m[Master Tool]\x1b[0m GetCategoricalSummaryOfFiles → ${params.path}`);
            try {

                const state = fileAgentRecord[params.ProcessId];
                if (!state) return "Error: Invalid ProcessId.";
                if (!state.workspacePath) return "Error: workspacePath not set in state.";
                const files  = state.fileByExtension[params.extension]
                if (files == undefined || files.length < 0) return "No files found with this extension. Report this to User.";
                
                const chunk = fileUtil.ChunkArray<fileStatus>(files, 20);
                state.workspacePath = params.path;
                state.lastReadInd = 0;

                const llama = await (await LLMService.getInstance()).llama;
                const grammer = await llama.createGrammarForJsonSchema({
                    type: "object",
                    properties:{
                        categories: {
                            type: "array",
                            description: "list of the category you have found",
                            items: {
                                type: "string",
                                description: "The name of the category you have found."
                            }
                        }
                    }
                });

                if( chunk.length < 0 || chunk === undefined) return "";
                let s = {};
                
                for (let index = 0; index < chunk.length; index++) {
                    const fileChunk = chunk[index];
                    const file = fileChunk.filter(x => x.status == false).map( x => x.fileName).join(' \n ');
                    
                    let userPrompt = "";
                    if (index === 0) {
                        userPrompt = `File Extension Type : "${params.extension}". \n List of files: \n ${file}`;
                    } else {
                        const category = JSON.stringify(s);
                        userPrompt = analysisWorkerNewSession(params.extension, category, file);
                    }

                    const summary = await workerAgent.getWorkerAgentWithFunctionsReact(
                        analysisWorkerSystemPrompt2(params.extension),
                        userPrompt,
                        {},
                        "AnalysisWorker"
                    );

                    // const summary : any = 
                    // await workerAgent.getWorkerAgentWithGrammar(
                    //     analysisWorkerSystemPrompt2(params.extension),
                    //     userPrompt,
                    //     grammer,
                    //     "AnalysisWorker"
                    // )
                    s = JSON.parse(summary);
                }


                return JSON.stringify(s);
            } catch (e: any) {
                return `Error during analysis: ${e.message}`;
            }
        }
    });

    const getFolderSummary = defineChatSessionFunction({
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
                let totalFileSize : number = 0;
                
                await Promise.all(files.map(async (file: fs.Dirent) => {
                    const fullPath = path.join(state.workspacePath, file.name);
                    try {
                        const stats = await fs.stat(fullPath);
                        const sizeKB = parseFloat((stats.size / 1024).toFixed(2));
                        totalFileSize += sizeKB;
                        const ext = path.extname(file.name) || "no extension";
                        state.AddFile(new fileStatus(file.name, fullPath, false, sizeKB, ext));
                    } catch(ex) {
                        console.log(`Error encountered while listing files ${ex}`)
                    }
                }));
                
                const fileCountByExt : Record<string, number> = {};
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
                            if (subFolder < 3){
                                const subDirs = await getAllDirectories(path.join(dirPath, entry.name), relPath, subFolder);
                                dirs = dirs.concat(subDirs);
                            }
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
            if (!state.workspacePath) return "Error: workspacePath not set in state.";

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
        description: "Provides the final summary of how many files were moved and how many files are remainning in the current workspace.",
        params: {
            type: "object",
            properties: {
                 path: {
                    type: "string",
                    description: "Absolute path of the workspace folder to analyze."
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
export const fileOrgMastertools = { getFolderSummary, GetCategoricalSummaryOfFilesByExtension, createFolders, executeMovePlan, finalSummary};
