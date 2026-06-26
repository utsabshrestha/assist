import * as path from 'path';
// import { defineChatSessionFunction } from 'node-llama-cpp';
import { fileAgentRecord } from '../src/state/fileAgentState.js';
import type { FolderPlanEntry, FolderPreviewEntry, fileStatus } from '../src/state/fileAgentState.js';
import { FileClassificationTool } from './fileClassificationTool.js';
import { ImageClassificationTool } from './imageClassificationTool.js';
import { stat } from 'fs';
import { Items } from 'openai/resources/conversations.mjs';
import { requestUserInput, requestFolderReview, emitTodoUpdate } from '../electron/ipcBridge.js';

export const workerCompletionStatus: Record<string, boolean> = {};

const FOLDER_PREVIEW_FILE_LIMIT = 5;

/**
 * Groups already-finalized files by their locked-in destination folder.
 * Reads `fileNewDestination` (set by Finalize tools) rather than `category`,
 * since this only runs post-approval — the mapping is final, no staleness risk.
 */
function buildFolderPreview(plan: FolderPlanEntry[], files: fileStatus[]): FolderPreviewEntry[] {
    return plan.map(entry => {
        const resolvedFolder = path.resolve(entry.folder);
        const matched = files.filter(f => f.fileNewDestination === resolvedFolder).map(f => f.fileName);
        return {
            category: entry.category,
            folder: entry.folder,
            files: matched.slice(0, FOLDER_PREVIEW_FILE_LIMIT),
            totalFileCount: matched.length
        };
    });
}

export const GetCategoriesOfImages = ({
    description: "Analyzes image files visually using the LLM vision capability. For each image, it generates a text description, embeds it, and clusters them to automatically produce descriptive category folder names. Returns a dictionary mapping the generated folder name to a brief list of the top 3 files in that category. Use this for image extensions like .jpg, .png, .jpeg, .webp, .gif.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session, provided by the user."
            },
            TaskId: {
                type: "number",
                description: "The Task Id of the todo list item being organized."
            },
            extensions: {
                type: "array",
                items: { type: "string" },
                description: "Array of image extensions to categorize together (e.g. ['.jpg', '.png', '.jpeg'])."
            }
        },
        required: [ "ProcessId", "TaskId", "extensions"]
    },
    async handler(params: {ProcessId: string, TaskId: number, extensions: string[]}): Promise<string> {
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

            // Auto-compute the folder plan now — the LLM never needs to construct paths itself.
            const baseFolder = `${state.workspacePath}/Images`;
            state.proposedFolderPlan[`__task_${params.TaskId}`] = Object.keys(categorized).map(category => ({
                category,
                folder: `${baseFolder}/${category}`
            }));

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

            // Auto-compute the folder plan now — the LLM never needs to construct paths itself.
            const extClean = params.extension.replace('.', '').toLowerCase();
            const baseFolder = `${state.workspacePath}/${extClean}`;
            state.proposedFolderPlan[params.extension] = Object.keys(categorized).map(category => ({
                category,
                folder: `${baseFolder}/${category}`
            }));

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
        for (const file of state.fileByExtension[params.extension]!) {

            if (file.category === params.oldCategoryName) {
                file.category = params.newCategoryName;
                updatedCount++;
            }
        }

        // Update proposedFolderPlan: rename oldCategory → newCategory (merge if newCategory already exists)
        if (state.proposedFolderPlan[params.extension]) {
            const plan = state.proposedFolderPlan[params.extension]!;
            const baseFolder = `${state.workspacePath}/${params.extension.replace('.', '')}`;

            // Replace or remove the old entry
            const filtered = plan.filter(e => e.category !== params.oldCategoryName);

            // Ensure the new category entry exists
            if (!filtered.find(e => e.category === params.newCategoryName)) {
                filtered.push({ category: params.newCategoryName, folder: `${baseFolder}/${params.newCategoryName}` });
            }

            state.proposedFolderPlan[params.extension] = filtered;
        }

        // Return the updated folder plan as ground truth so the LLM doesn't reconstruct from memory
        const updatedPlan = state.proposedFolderPlan[params.extension] ?? [];
        return JSON.stringify({
            message: `Successfully updated category name from '${params.oldCategoryName}' to '${params.newCategoryName}' for ${updatedCount} files.`,
            updatedFolderPaths: updatedPlan
        });
    }
});

export const FinalizeThefolderforthefilesforEachExtensions = ({
     description: "Finalizes the already-prepared folder plan for this document extension. The plan was already computed automatically — you do not need to build or pass it.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session, provided by the user."
            },
            extension: {
                type: "string",
                description: "The file extension being finalized, eg .pdf, .docx, .txt"
            }
        },
        required: ["extension", "ProcessId"]
    },
    async handler(params: {ProcessId: string, extension: string}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m FinalizeThefolderforthefilesforEachExtensions → ${params.ProcessId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const exts = params.extension;
        const folderStructure = state.proposedFolderPlan[params.extension] ?? [];

        if (!exts || exts.length === 0) {
            return "Error: No extension provided. Please report to the User.";
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

        // Broadcast the finalized folder → file breakdown to the sidebar's per-extension sub-task.
        const preview = buildFolderPreview(folderStructure, state.fileByExtension[exts]);
        const task = state.todoList.find(t => t.extensionList.includes(exts));
        const subTask = task?.subTasks?.find(s => s.extension === exts);
        if (subTask) {
            subTask.folderPreview = preview;
            emitTodoUpdate(state.todoList);
        }

        return `Successfully finalized destination folder for ${updatedCount} files across extensions: ${exts}.`;
    }
});

export const FinalizeThefolderforImages = ({
     description: "Finalizes the already-prepared folder plan for this images task. The plan was already computed automatically — you do not need to build or pass it.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session, provided by the user."
            },
            TaskId: {
                type: "number",
                description: "The Task Id of the todo list item being organized."
            }
        },
        required: ["ProcessId", "TaskId"]
    },
    async handler(params: {ProcessId: string, TaskId: number}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m FinalizeThefolderforImages → ${params.ProcessId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const exts = state.todoList.filter(task => task.id == params.TaskId).flatMap(todo => todo.extensionList);
        const folderStructure = state.proposedFolderPlan[`__task_${params.TaskId}`] ?? [];

        if (!exts || exts.length === 0) {
            return "Error: No extensions found for this task id.";
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

        // Broadcast the finalized folder → file breakdown to the sidebar, unioned across all extensions in this task.
        const allFiles = exts.flatMap(ext => state.fileByExtension[ext] ?? []);
        const preview = buildFolderPreview(folderStructure, allFiles);
        const task = state.todoList.find(t => t.id === params.TaskId);
        if (task) {
            task.folderPreview = preview;
            emitTodoUpdate(state.todoList);
        }

        return `Successfully finalized destination folder for ${updatedCount} files across extensions: ${exts.join(', ')}.`;
    }
});

export const FinalizeThefolderforNonDocuments = ({
     description: "Finalizes the already-prepared folder plan for this task. The plan was already computed automatically — you do not need to build or pass it.",
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
    async handler(params: {ProcessId: string, TaskId: number}): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m FinalizeThefolderforNonDocuments → ${params.ProcessId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const extensionsList = state.todoList.filter(task => task.id == params.TaskId).flatMap(todo => todo.extensionList);
        const folderStructure = state.proposedFolderPlan[`__task_${params.TaskId}`] ?? [];

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

        // Broadcast the finalized folder → file breakdown to the sidebar, unioned across all extensions in this task.
        const allFiles = extensionsList.flatMap(ext => state.fileByExtension[ext] ?? []);
        const preview = buildFolderPreview(folderStructure, allFiles);
        const task = state.todoList.find(t => t.id === params.TaskId);
        if (task) {
            task.folderPreview = preview;
            emitTodoUpdate(state.todoList);
        }

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

            // Auto-compute the folder plan now — the LLM never needs to construct paths itself.
            const baseFolder = state.workspacePath;
            state.proposedFolderPlan[`__task_${params.TaskId}`] = categoriesList.map(category => ({
                category,
                folder: `${baseFolder}/${category}`
            }));

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

        // Derive a stable plan key for non-documents (use TaskId as key prefix)
        const planKey = `__task_${params.TaskId}`;
        if (state.proposedFolderPlan[planKey]) {
            const plan = state.proposedFolderPlan[planKey];
            const baseFolder = state.workspacePath;

            const filtered = plan.filter(e => e.category !== params.oldCategoryName);
            if (!filtered.find(e => e.category === params.newCategoryName)) {
                filtered.push({ category: params.newCategoryName, folder: `${baseFolder}/${params.newCategoryName}` });
            }
            state.proposedFolderPlan[planKey] = filtered;
        }

        const updatedPlan = state.proposedFolderPlan[`__task_${params.TaskId}`] ?? [];
        return JSON.stringify({
            message: `Successfully updated category name from '${params.oldCategoryName}' to '${params.newCategoryName}'`,
            updatedFolderPaths: updatedPlan
        });
    }
});

/**
 * UpdateCategoryNameForImagesTool
 *
 * Image-specific sibling of UpdateCategoryNameForNonDocumentsTool. Images' folder plan
 * is keyed by TaskId (not by extension, since one task may cover multiple image extensions
 * organized as a single unit), so this rebuilds state.proposedFolderPlan[`__task_${TaskId}`]
 * the same way the non-documents version does.
 */
export const UpdateCategoryNameForImagesTool = ({
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
        console.log(`\x1b[95m[Worker Tool]\x1b[0m UpdateCategoryNameForImagesTool -> '${params.oldCategoryName}' to '${params.newCategoryName}'`);
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

        const planKey = `__task_${params.TaskId}`;
        if (state.proposedFolderPlan[planKey]) {
            const plan = state.proposedFolderPlan[planKey];
            const baseFolder = `${state.workspacePath}/Images`;

            const filtered = plan.filter(e => e.category !== params.oldCategoryName);
            if (!filtered.find(e => e.category === params.newCategoryName)) {
                filtered.push({ category: params.newCategoryName, folder: `${baseFolder}/${params.newCategoryName}` });
            }
            state.proposedFolderPlan[planKey] = filtered;
        }

        const updatedPlan = state.proposedFolderPlan[`__task_${params.TaskId}`] ?? [];
        return JSON.stringify({
            message: `Successfully updated category name from '${params.oldCategoryName}' to '${params.newCategoryName}' for ${updatedCount} files.`,
            updatedFolderPaths: updatedPlan
        });
    }
});

/**
 * PresentDocumentFolderPlanTool
 *
 * Shows the user a structured Approve/Deny/Message UI panel for the proposed folder
 * plan and blocks until they respond, returning a typed sentinel string.
 * The folder plan for a document extension is already computed automatically by
 * GetCategoriesoffilesofspecificextension (and kept up to date by UpdateCategoryNameTool),
 * so this tool never accepts an LLM-authored folderPlan param — it only reads
 * state.proposedFolderPlan as ground truth.
 *
 * Return values:
 *   "USER_APPROVED"              → agent should call FinalizeThe... immediately
 *   "USER_MESSAGE: <text>"       → agent should interpret as rename/merge/freeform request
 */
export const PresentDocumentFolderPlanTool = ({
    description: "Present the already-prepared folder plan for this document extension to the user via a structured UI panel with Approve and Request Changes options. The plan was already computed automatically — you do not need to build or pass it. Returns 'USER_APPROVED' or 'USER_MESSAGE: <their request>'.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session." },
            extension: { type: "string", description: "The file extension being organized, e.g. '.pdf'." }
        },
        required: ["ProcessId", "extension"]
    },
    async handler(params: { ProcessId: string; extension: string }): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m PresentDocumentFolderPlanTool → ${params.ProcessId} / ${params.extension}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const folderPlan = state.proposedFolderPlan[params.extension] ?? [];

        // Ask the renderer to show the structured Approve/Message UI and wait for the user's response
        const response = await requestFolderReview(params.extension, folderPlan);

        if (response.action === 'approve') {
            return 'USER_APPROVED';
        }
        return `USER_MESSAGE: ${response.message ?? 'User declined without a message. Ask what they would like to change.'}`;
    }
});

/**
 * PresentImageFolderPlanTool
 *
 * Image-specific sibling of PresentFolderPlanTool. The folder plan for the images task
 * is already computed automatically by GetCategoriesOfImages (and kept up to date by
 * UpdateCategoryNameForImagesTool), keyed by TaskId — never accepts an LLM-authored folderPlan.
 */
export const PresentImageFolderPlanTool = ({
    description: "Present the already-prepared folder plan for these image extensions to the user via a structured UI panel with Approve and Request Changes options. The plan was already computed automatically — you do not need to build or pass it. Returns 'USER_APPROVED' or 'USER_MESSAGE: <their request>'.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session." },
            TaskId: { type: "number", description: "The Task Id of the todo list item being organized." }
        },
        required: ["ProcessId", "TaskId"]
    },
    async handler(params: { ProcessId: string; TaskId: number }): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m PresentImageFolderPlanTool → ${params.ProcessId} / Task ${params.TaskId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const folderPlan = state.proposedFolderPlan[`__task_${params.TaskId}`] ?? [];

        const response = await requestFolderReview("__images__", folderPlan);

        if (response.action === 'approve') {
            return 'USER_APPROVED';
        }
        return `USER_MESSAGE: ${response.message ?? 'User declined without a message. Ask what they would like to change.'}`;
    }
});

/**
 * PresentNonDocumentFolderPlanTool
 *
 * Non-document-specific sibling of PresentFolderPlanTool. The folder plan for the task
 * is already computed automatically by GetCategoriesForNonDocuments (and kept up to date
 * by UpdateCategoryNameForNonDocumentsTool), keyed by TaskId — never accepts an LLM-authored folderPlan.
 */
export const PresentNonDocumentFolderPlanTool = ({
    description: "Present the already-prepared folder plan for this task to the user via a structured UI panel with Approve and Request Changes options. The plan was already computed automatically — you do not need to build or pass it. Returns 'USER_APPROVED' or 'USER_MESSAGE: <their request>'.",
    params: {
        type: "object",
        properties: {
            ProcessId: { type: "string", description: "The unique process id for this session." },
            TaskId: { type: "number", description: "The Task Id of the todo list item being organized." }
        },
        required: ["ProcessId", "TaskId"]
    },
    async handler(params: { ProcessId: string; TaskId: number }): Promise<string> {
        console.log(`\x1b[95m[Worker Tool]\x1b[0m PresentNonDocumentFolderPlanTool → ${params.ProcessId} / Task ${params.TaskId}`);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const folderPlan = state.proposedFolderPlan[`__task_${params.TaskId}`] ?? [];

        const response = await requestFolderReview("__non_documents__", folderPlan);

        if (response.action === 'approve') {
            return 'USER_APPROVED';
        }
        return `USER_MESSAGE: ${response.message ?? 'User declined without a message. Ask what they would like to change.'}`;
    }
});