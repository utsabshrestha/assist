import * as path from 'path';
// import { defineChatSessionFunction } from 'node-llama-cpp';
import { fileAgentRecord } from '../src/state/fileAgentState.js';
import { FileClassificationTool } from './fileClassificationTool.js';
import { ImageClassificationTool } from './imageClassificationTool.js';
import { stat } from 'fs';
import { Items } from 'openai/resources/conversations.mjs';
import { requestUserInput } from '../electron/ipcBridge.js';

export const workerCompletionStatus: Record<string, boolean> = {};

export const GetCategoriesOfImages = ({
    description: "Analyzes image files visually using the LLM vision capability. For each image, it generates a text description, embeds it, and clusters them to automatically produce descriptive category folder names. Returns a dictionary mapping the generated folder name to a brief list of the top 3 files in that category. Use this for image extensions like .jpg, .png, .jpeg, .webp, .gif.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session, provided by the user."
            },
            extensions: {
                type: "array",
                items: { type: "string" },
                description: "Array of image extensions to categorize together (e.g. ['.jpg', '.png', '.jpeg'])."
            }
        },
        required: [ "ProcessId", "extensions"]
    },
    async handler(params: {ProcessId: string, extensions: string[]}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m GetCategoriesOfImages → ${params.ProcessId} for ${params.extensions.join(', ')}`);
        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";
            if (!state.workspacePath) return "Error: workspacePath not set in state.";


            // Collect all image files across the requested extensions
            const allImageFiles: string[] = [];
            for (const ext of params.extensions) {
                const files = state.fileByExtension[ext];
                if (files && files.length > 0) {
                    const unprocessed = files.filter(x => x.planConfirmed === false);
                    for (const file of unprocessed) {
                        allImageFiles.push(path.join(state.workspacePath, file.fileName));
                    }
                }
            }

            if (allImageFiles.length === 0) return "No unprocessed image files found for these extensions.";

            // Delegate to the vision-based classification pipeline
            const categorized = await ImageClassificationTool.clusterAndNameImages(allImageFiles);

            // Update the category property of the files in the state
            for (const [folderName, fileNames] of Object.entries(categorized)) {
                for (const fileName of fileNames) {
                    if (state.fileRecord[fileName]) {
                        state.fileRecord[fileName].category = folderName;
                    }
                }
            }

            // Prepare a summarized payload (max 3 files per category) to save tokens
            const categorizedSummary: Record<string, string[]> = {};
            for (const [folderName, fileNames] of Object.entries(categorized)) {
                categorizedSummary[folderName] = fileNames.slice(0, 3);
                if (fileNames.length > 3) {
                    categorizedSummary[folderName].push(`...and ${fileNames.length - 3} more files`);
                }
            }

            return JSON.stringify(categorizedSummary);
        } catch (e: any) {
            return `Error during image analysis: ${e.message}`;
        }
    }
});

export const GetCategoriesoffilesofspecificextension = ({
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
        required: ["extension", "ProcessId"]
    },
    async handler(params: {ProcessId: string, extension: string}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m GetCategoricalSummaryOfFiles → ${params.ProcessId}`);
        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";
            if (!state.workspacePath) return "Error: workspacePath not set in state.";

            const files  = state.fileByExtension[params.extension]
            if (files == undefined || files.length < 0) return "No files found with this extension. Report this to User.";
            
            state.lastReadInd = 0;

            // Extract unmatched file paths to be grouped (using actual absolute path in fileStatus model)
            const filePaths = files.filter(x => x.planConfirmed == false).map(x => path.join(state.workspacePath, x.fileName));
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

export const UpdateCategoryNameTool = ({
    description: "Updates the category name for files that currently belong to an old category. Use this when the user wants to rename a proposed category before finalizing folders. This tool can also combine two category by combining old category to new category. This tool also can combine two folders by combining old folder to the new folder.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            extension: { type: "string" },
            oldCategoryName: { type: "string", description: "The existing category name to be changed." },
            newCategoryName: { type: "string", description: "The new category name requested by the user." }
        },
        required: ["ProcessId", "extension", "oldCategoryName", "newCategoryName"]
    },
    async handler(params: {ProcessId: string, extension: string, oldCategoryName: string, newCategoryName: string}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m UpdateCategoryNameTool -> '${params.oldCategoryName}' to '${params.newCategoryName}'`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        
        if (!state.fileByExtension[params.extension]) {
            return `Error: No files found for extension ${params.extension}`;
        }

        let updatedCount = 0;
        for (const file of state.fileByExtension[params.extension]) {
            if (file.category === params.oldCategoryName) {
                file.category = params.newCategoryName;
                updatedCount++;
            }
        }

        return `Successfully updated category name from '${params.oldCategoryName}' to '${params.newCategoryName}' for ${updatedCount} files.`;
    }
});

export const FinalizeThefolderforthefilesforEachExtensions = ({
     description: "This tool will finalize the folder for the files types you have passed.",
    params: {
        type: "object",
        properties: {
            json: {
                type: "object",
                description: "An object containing extensions, category, and folder structure.",
                properties: {
                    extensions: {
                        type: "string",
                        description: "Extension being finalized, eg .pdf, .docx, .txt"
                    },
                    folderStructure: {
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
    async handler(params: {ProcessId: string, json: any}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m FinalizeThefolderforthefilesforEachExtensions → ${params.ProcessId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const exts = params.json.extensions;
        const folderStructure = params.json.folderStructure;
        
        if (!exts || exts.length === 0) {
            return "Error: No extensions provided in the json object. Please report to the User.";
        }

        let updatedCount = 0;
        
        if (!state.fileByExtension[exts])
                return "The extension you have provided is not available in our memory. Please report to the User.";

        // Iterate through every file of this extension in the global state
        for (const file of state.fileByExtension[exts]) {
            // Find mapping by exact category match, generic default match, or fallback to the first folder provided if no category exists
            const mapping = folderStructure.find((f: any) => f.category === file.category) 
                            || folderStructure.find((f: any) => !f.category || f.category.trim() === "")
                            || (folderStructure.length === 1 ? folderStructure[0] : null);
            
            if (mapping && mapping.folder) {
                const resolvedTarget = path.resolve(mapping.folder);
                if (!resolvedTarget.startsWith(path.resolve(state.workspacePath))) {
                    return `Error: The folder path '${mapping.folder}' is outside the authorized workspace path '${state.workspacePath}'. All folders must be strictly inside the workspace. Please report to the User.`;
                }
                file.fileNewDestination = resolvedTarget;
                file.planConfirmed = true;
                updatedCount++;
            }
        }

        workerCompletionStatus[`${params.ProcessId}_${exts.replaceAll(".", "")}`] = true;

        return `Successfully finalized destination folder for ${updatedCount} files across extensions: ${exts}.`;
    }
});

export const FinalizeThefolderforImages = ({
     description: "This tool will finalize the folder for the files types you have passed.",
    params: {
        type: "object",
        properties: {
            json: {
                type: "object",
                description: "An object containing extensions, category, and folder structure.",
                properties: {
                    extensions: {
                        type: "array",
                        items: { type: "string" },
                        description: "Array of extensions being finalized (e.g. ['.jpg', '.png'])."
                    },
                    folderStructure: {
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
    async handler(params: {ProcessId: string, json: any}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m FinalizeThefolderforImages → ${params.ProcessId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const exts = params.json.extensions;
        const folderStructure = params.json.folderStructure;
        
        if (!exts || exts.length === 0) {
            return "Error: No extensions provided in the json object.";
        }

        let updatedCount = 0;
        
        for (const ext of exts) {
            if (!state.fileByExtension[ext]) continue;

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
                    file.fileNewDestination = resolvedTarget;
                    file.planConfirmed = true;
                    updatedCount++;
                }
            }

            workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`] = true;
        }

        return `Successfully finalized destination folder for ${updatedCount} files across extensions: ${exts.join(', ')}.`;
    }
});

export const FinalizeThefolderforNonDocuments = ({
     description: "This tool will finalize the folder for the files types you have passed.",
    params: {
        type: "object",
        properties: {
            json: {
                type: "object",
                description: "An object containing category, and folder structure.",
                properties: {
                    folderStructure: {
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
            },
            TaskId: {
                type: "number",
                description: "Task id of this task."
            }
        },
        required: ["json", "ProcessId"]
    },
    async handler(params: {ProcessId: string, TaskId: number, json: any}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m FinalizeThefolderforImages → ${params.ProcessId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const extensionsList = state.todoList.filter(task => task.id == params.TaskId).flatMap(todo => todo.extensionList);
        const folderStructure = params.json.folderStructure;
        
        if (!extensionsList || extensionsList.length === 0) {
            return "Error: No extensions provided for this task id.";
        }

        let updatedCount = 0;
        
        for (const ext of extensionsList) {
            if (!state.fileByExtension[ext]) continue;

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
                    file.fileNewDestination = resolvedTarget;
                    file.planConfirmed = true;
                    updatedCount++;
                }
            }

            workerCompletionStatus[`${params.ProcessId}_${ext.replaceAll(".", "")}`] = true;
        }
        workerCompletionStatus[`${params.ProcessId}_TaskId${params.TaskId}`] = true;
        return `Successfully finalized destination folder.`;
    }
});


export const GetCategoriesForNonDocuments = {
    description: "Analyzes the extensions and give them a categorical name.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session, provided by the user."
            },
            TaskId: {
                type: "number",
                description: "Task id of this task."
            }
        },
        required: ["ProcessId", "TaskId"]
    },
    async handler(params: { ProcessId: string; TaskId: number }): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m GetCategoriesForNonDocuments → ${params.ProcessId} for Task Id : ${params.TaskId}`);
        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return "Error: Invalid ProcessId.";
            if (!state.workspacePath) return "Error: workspacePath not set in state.";
            const extensionsList = state.todoList.filter(task => task.id == params.TaskId).flatMap(todo => todo.extensionList);

            const categorized = await FileClassificationTool.GetNonDocumentExtensionCategorized(extensionsList);
            const categoriesList : string[] = [];
            // Update the category property of the files in the state
            for (const [category, extensions] of Object.entries(categorized)) {
                categoriesList.push(category);
                for (const ext of extensions) {
                    if (ext === undefined) continue;
                    
                    // Ensure the array exists before iterating
                    if (state.fileByExtension[ext]) {
                        for (const file of state.fileByExtension[ext]) {
                            file.category = category;
                        }
                    }
                }
            }

            return JSON.stringify(categoriesList);
        } catch (e: any) {
            return `Error during non-document categorization: ${e.message}`;
        }
    }
};

export const UpdateCategoryNameForNonDocumentsTool = ({
    description: "Updates the category name from old category to new category name. Use this when the user wants to rename a proposed category before finalizing folders.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string" },
            TaskId: { type: "number", description: "Task id of the task you are working on" },
            oldCategoryName: { type: "string", description: "The existing category name to be changed." },
            newCategoryName: { type: "string", description: "The new category name requested by the user." }
        },
        required: ["ProcessId", "TaskId", "oldCategoryName", "newCategoryName"]
    },
    async handler(params: {ProcessId: string, TaskId: number, oldCategoryName: string, newCategoryName: string}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m UpdateCategoryNameTool -> '${params.oldCategoryName}' to '${params.newCategoryName}'`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        
        const extensionsList = state.todoList.filter(task => task.id == params.TaskId).flatMap(todo => todo.extensionList);

        const filesWithOldCategory = state.fileListData.filter(file => file.category == params.oldCategoryName);

        let updatedCount = 0;
        for (const file of filesWithOldCategory) {
            if (extensionsList.includes(file.ext)) {
                file.category = params.newCategoryName;
                updatedCount++;
            }
        }

        return `Successfully updated category name from '${params.oldCategoryName}' to '${params.newCategoryName}'`;
    }
});

export const RequestFolderApproval = ({
    description: "Call this tool when you have decided on a folder structure and need the user's explicit approval before finalizing them.",
    params: {
        type: "object",
        properties: {
            ProcessId:{ type: "string"},
            TaskId: { type: "number", description: "Task id of the task you are working on" },
            ProposedFolders: { 
                type: "array", 
                items: {
                    type: "string"
                },
                description: "The list of absolute or relative folder paths you propose to create." 
            },
        },
        required: ["ProcessId", "TaskId", "proposed_folders"]
    },
    async handler(params : {ProcessId: string,TaskId: number,  ProposedFolders: string[]}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m RequestFolderApproval -> '${params.ProcessId}' to '${params.TaskId}'`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        
        return new Promise(async (resolve) => {
            var response = await requestUserInput("Request folder Approval");
        }

    }
});