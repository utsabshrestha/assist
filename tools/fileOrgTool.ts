import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { defineChatSessionFunction, getLlama, LlamaJsonSchemaGrammar } from 'node-llama-cpp';
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
import { FileClassificationTool } from './fileClassificationTool.js';
import { FileContentExtractor } from '../src/utils/fileContentExtractor.js';

const GetCategoriesoffilesofspecificextension = defineChatSessionFunction({
        description: "Analyzes the contents of files for a given extension, generating embeddings and using an AI clustering algorithm to automatically group them into highly descriptive category folder names. Returns a dictionary mapping the generated folder name to a brief list of the top 3 files in that category to save context. Use this to automatically generate folder names based on actual file content.",
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
                
                state.workspacePath = params.path;
                state.lastReadInd = 0;

                // Extract unmatched file paths to be grouped (using actual absolute path in fileStatus model)
                const filePaths = files.filter(x => x.status == false).map(x => path.join(state.workspacePath, x.fileName));
                if (filePaths.length === 0) return "All files of this extension are already processed.";

                // Delegate to the new AI Clustering logic using embeddings & AgglomerativeClustering
                const categorized = await FileClassificationTool.clusterAndNameFiles(filePaths);

                // Update the category property of the files in the state
                for (const [folderName, fileNames] of Object.entries(categorized)) {
                    for (const fileName of fileNames) {
                        if (state.fileRecord[fileName]) {
                            state.fileRecord[fileName].category = folderName;
                        }
                    }
                }

                // Prepare a summarized payload for the master agent (max 3 files per category) to save tokens
                const categorizedSummary: Record<string, string[]> = {};
                for (const [folderName, fileNames] of Object.entries(categorized)) {
                    categorizedSummary[folderName] = fileNames.slice(0, 3);
                    if (fileNames.length > 3) {
                        categorizedSummary[folderName].push(`...and ${fileNames.length - 3} more files`);
                    }
                }

                return JSON.stringify(categorizedSummary);
            } catch (e: any) {
                return `Error during analysis: ${e.message}`;
            }
        }
    });

    const GetFolderSummaryTool = defineChatSessionFunction({
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
                        const ext = path.extname(file.name).toLowerCase() || "no extension";
                        
                        // Assign default categories based on common file extensions
                        let defaultCategory = "";
                        if (['.jpg', '.png', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
                            defaultCategory = "Images";
                        } else if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
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

    const FinalizeThefolderforthefilesforEachExtensions = defineChatSessionFunction({
         description: "This tool will finalize the folder for the files types you have passed.",
        params: {
            type: "object",
            properties: {
                json: {
                    type: "object",
                    description: "An object of file extension, category and folder",
                    properties: {
                        extension : {
                            type: "string",
                            description: "extension of a file you are finalizing"
                        },
                        folderStructure : {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    category: {
                                        type : "string",
                                        description: "category name"
                                    },
                                    folder: {
                                        type: "string",
                                        description: "absolute path of the folder to be created for this category."
                                    }
                                }
                            }
                        }
                    }
                },
                ProcessId: {
                    type: "string",
                    description: "The unique process id for this session, provided by the user."
                }
            },
            required: ["json", "ProcessId"]
        },
        async handler(params): Promise<string> {
            console.log(`\x1b[95m[Master Tool]\x1b[0m FinalizeThefolderforthefilesforEachExtensions → ${params.ProcessId}`);
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";
    
            const ext = params.json.extension;
            const folderStructure = params.json.folderStructure;

            if (!state.fileByExtension[ext]) {
                return `Error: No files found for extension ${ext}`;
            }

            let updatedCount = 0;
            // Iterate through every file of this extension in the global state
            for (const file of state.fileByExtension[ext]) {
                // Find mapping by exact category match, generic default match, or fallback to the first folder provided if no category exists
                const mapping = folderStructure.find((f: any) => f.category === file.category) 
                             || folderStructure.find((f: any) => !f.category || f.category.trim() === "")
                             || (folderStructure.length === 1 ? folderStructure[0] : null);
                
                if (mapping && mapping.folder) {
                    const resolvedTarget = path.resolve(mapping.folder);
                    if (!resolvedTarget.startsWith(path.resolve(state.workspacePath))) {
                        return `Error: The folder path '${mapping.folder}' is outside the authorized workspace path '${state.workspacePath}'. All folders must be strictly inside the workspace.`;
                    }
                    file.folderPath = resolvedTarget;
                    updatedCount++;
                }
            }

            return `Successfully finalized destination folder for ${updatedCount} files (Extension: ${ext}).`;
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

    const getFinalPlanConfirmation = defineChatSessionFunction({
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

            // === FOLDER DE-DUPLICATION WORKER ===
            const originalFolders = Object.keys(plan);
            if (originalFolders.length > 1) {
                console.log("\n\x1b[93m[System]\x1b[0m Spinning up De-duplication Worker to merge semantically identical folders...");
                const llmService = await LLMService.getInstance();
                
                const dedupeGrammar = new LlamaJsonSchemaGrammar(llmService.llama, {
                    type: "object",
                    properties: {
                        merges: {
                            type: "array",
                            description: "List of folder merges. Only include folders that mean the exact same thing.",
                            items: {
                                type: "object",
                                properties: {
                                    source: { type: "string" },
                                    target: { type: "string" }
                                },
                                required: ["source", "target"]
                            }
                        }
                    },
                    required: ["merges"]
                } as const);

                const dedupePrompt = `Review this list of generated folder names. Identify any redundant folders that mean the exact same thing (e.g. "Tax_Documents" and "Taxes_2023").\n\nFolders:\n${JSON.stringify(originalFolders)}\n\nIMPORTANT: Only merge if absolutely certain. Provide the merges as a JSON.`;

                try {
                    const dedupeResult = await workerAgent.getWorkerAgentWithGrammar<{merges: {source: string, target: string}[]}>(
                        "You are an expert data taxonomist. Merge equivalent categories.",
                        dedupePrompt,
                        dedupeGrammar,
                        "De-duplication Worker"
                    );

                    let merges = dedupeResult && typeof dedupeResult !== "string" ? dedupeResult.merges : [];
                    if (typeof dedupeResult === "string" && dedupeResult.trim() !== "") {
                        try { merges = JSON.parse(dedupeResult).merges; } catch (e) {}
                    }

                    if (merges && merges.length > 0) {
                        console.log(`\x1b[92m[Worker]\x1b[0m Found ${merges.length} redundant folders. Consolidating...`);
                        
                        // Apply merges to global state
                        for (const files of Object.values(state.fileByExtension)) {
                            for (const file of files) {
                                if (file.folderPath) {
                                    const baseFolder = path.basename(file.folderPath);
                                    const merge = merges.find(m => m.source === baseFolder || m.source === file.folderPath);
                                    if (merge) {
                                        const newDir = path.dirname(file.folderPath) !== '.' ? path.dirname(file.folderPath) : state.workspacePath;
                                        const newTarget = path.join(newDir, merge.target);
                                        file.folderPath = newTarget;
                                    }
                                }
                            }
                        }

                        // Rebuild plan
                        plan = {};
                        for (const files of Object.values(state.fileByExtension)) {
                            for (const file of files) {
                                if (file.folderPath) {
                                    if (!plan[file.folderPath]) plan[file.folderPath] = [];
                                    if (!plan[file.folderPath].includes(file.fileName)) {
                                        plan[file.folderPath].push(file.fileName);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error("\x1b[91mError during De-duplication Worker:\x1b[0m", e);
                }
            }
            // ===================================

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
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            return new Promise((resolve) => {
                rl.question("\x1b[95mDo you confirm this plan? [Type 'confirm' to proceed, or type changes you want]: \x1b[0m", (answer) => {
                    rl.close();
                    const trimmed = answer.trim().toLowerCase();
                    if (trimmed === 'confirm' || trimmed === 'y' || trimmed === 'yes') {
                        resolve("User confirmed the plan exactly as is. You may proceed to create the folders and execute the move plan.");
                    } else {
                        resolve(`User requests changes to the plan: "${answer}". Please adjust the categories/folders as requested by the user using the Finalize tool again, or respond accordingly.`);
                    }
                });
            });
        }
    });

    const RenameGenericFiles = defineChatSessionFunction({
        description: "Scans for poorly named document files (like 'untitled' or 'scan_123') and intelligently renames them based on their content using an AI worker. Call this right before 'getFinalPlanConfirmation' or 'Executetheprocess' to ensure files are renamed properly.",
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
            console.log(`\x1b[95m[Master Tool]\x1b[0m RenameGenericFiles → ${params.ProcessId}`);
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";

            // Regex looks for "untitled", "scan", "document", "img" or just numbers at the start of the filename
            const genericRegex = /^scan|^untitled|^[0-9]{8,}|^img|^document/i;
            let renamedCount = 0;

            const filesToRename = state.fileListData.filter(f => genericRegex.test(f.fileName) && f.status === false);

            if (filesToRename.length === 0) {
                return "No generically named files found to rename. Proceed to the next step.";
            }

            console.log(`\x1b[93m[System]\x1b[0m Spinning up File Renaming Worker for ${filesToRename.length} files...`);

            const llmService = await LLMService.getInstance();
            const renameGrammar = new LlamaJsonSchemaGrammar(llmService.llama, {
                type: "object",
                properties: {
                    newName: { type: "string" }
                },
                required: ["newName"]
            } as const);

            for (const file of filesToRename) {
                const content = await FileContentExtractor.extractContent(path.join(state.workspacePath, file.fileName));
                if (!content || content.length < 20) continue;

                const prompt = `Based on the following content snippet, generate a short, descriptive 3-5 word filename using snake_case (keep the original extension: ${file.ext}). Do not include folder paths.\n\nContent:\n${content}`;
                
                try {
                    const response = await workerAgent.getWorkerAgentWithGrammar<{newName: string}>(
                        "You are an expert file organizer. Generate a descriptive snake_case filename. Only output the JSON.", 
                        prompt, 
                        renameGrammar, 
                        "Renaming Worker"
                    );
                    
                    let newName = (response && typeof response !== 'string') ? response.newName : "";
                    if (typeof response === 'string' && response.trim() !== '') {
                        try { newName = JSON.parse(response).newName; } catch(e) {}
                    }

                    if (newName) {
                        if (!newName.toLowerCase().endsWith(file.ext.toLowerCase())) newName += file.ext;
                        
                        console.log(`\x1b[92m[Worker]\x1b[0m Renaming "${file.fileName}" -> "${newName}"`);
                        
                        // We strictly update state. so `Executetheprocess` handles the actual rename operation seamlessly.
                        file.fileName = newName;
                        renamedCount++;
                    }
                } catch (e) {
                    console.error("Rename error for file", file.fileName, e);
                }
            }
            
            return `Successfully generated descriptive names for ${renamedCount} previously poorly-named files. You should now use getFinalPlanConfirmation or Executetheprocess.`;
        }
    });

    const Executetheprocess = defineChatSessionFunction({
        description: "Executes the finalized file movement plan. Automatically creates all required folders and moves the files. It handles errors gracefully without crashing and returns a comprehensive summary of successes and any errors.",
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

export const fileOrgMastertools = { GetFolderSummaryTool, GetCategoriesoffilesofspecificextension, FinalizeThefolderforthefilesforEachExtensions, RenameGenericFiles, getFinalPlanConfirmation, Executetheprocess};
