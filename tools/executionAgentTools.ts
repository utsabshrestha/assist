import path from "path";
import { fileAgentRecord, fileStatus } from "../src/state/fileAgentState.js";
import type { fileAgentState, PlanScope, PlanScopeGroup, PlanFolderEntry, FolderPlanEntry } from "../src/state/fileAgentState.js";
import { mkdir } from 'node:fs/promises';
import { rename } from 'node:fs/promises'
import { ErrorEncountered } from "./pipelineTools.js";
import { emitAgentMessage, emitLog, requestExecutionPlanConfirmation } from "../electron/ipcBridge.js";
import type { ExecutionPlanFileAssignment } from "../electron/ipcBridge.js";

/** Builds the full (untruncated) file list for one proposed folder, read from fileNewDestination ground truth. */
function buildPlanFolderEntry(entry: FolderPlanEntry, files: fileStatus[]): PlanFolderEntry {
    const resolvedFolder = path.resolve(entry.folder);
    const matched = files.filter(f => f.fileNewDestination === resolvedFolder);
    return {
        category: entry.category,
        folder: entry.folder,
        files: matched.map(f => ({ fileName: f.fileName, fileSize: f.fileSize }))
    };
}

/** Transforms the current finalized state into the editable plan payload sent to the renderer. */
function buildExecutionPlanRequest(state: fileAgentState): { scopes: PlanScopeGroup[]; unassignedCount: number } {
    const scopes: PlanScopeGroup[] = [];

    const docTask = state.todoList.find(t => t.subTasks && t.subTasks.length > 0);
    if (docTask?.subTasks?.length) {
        const extensionGroups = [];
        for (const sub of docTask.subTasks) {
            const planEntries = state.proposedFolderPlan[sub.extension] ?? [];
            const files = state.fileByExtension[sub.extension] ?? [];
            const folders = planEntries.map(entry => buildPlanFolderEntry(entry, files));
            if (folders.length) extensionGroups.push({ extension: sub.extension, folders });
        }
        if (extensionGroups.length) scopes.push({ scope: 'documents', extensionGroups });
    }

    for (const task of state.todoList) {
        if (task.subTasks?.length) continue; // already handled above as documents
        const planEntries = state.proposedFolderPlan[`__task_${task.id}`];
        if (!planEntries?.length) continue;
        const isImages = task.extensionList.every(ext => state.categorySummary.images.includes(ext));
        const allFiles = task.extensionList.flatMap(ext => state.fileByExtension[ext] ?? []);
        const folders = planEntries.map(entry => buildPlanFolderEntry(entry, allFiles));
        if (folders.length) scopes.push({ scope: isImages ? 'images' : 'non-documents', folders });
    }

    const unassignedCount = state.fileListData.filter(f => f.planConfirmed === false).length;
    return { scopes, unassignedCount };
}

/** Resolves the base folder convention for a scope, matching the Finalize tools' own path construction exactly. */
function resolveBaseFolder(workspacePath: string, scope: PlanScope, extension?: string): string {
    if (scope === 'documents') return path.join(workspacePath, (extension ?? '').replace('.', ''));
    if (scope === 'images') return path.join(workspacePath, 'Images');
    return workspacePath; // non-documents
}

/** Folder names from the renderer must always be a single path segment — never a path, never traversal. */
function sanitizeFolderName(name: string): string {
    return name.replace(/[\\/]/g, '_').replace(/\.\./g, '_').trim();
}

/**
 * Applies the user's edited plan onto state, reconstructing and re-validating every destination
 * path server-side. The renderer only ever sends bare folder names — never absolute paths.
 */
function applyExecutionPlanResponse(state: fileAgentState, assignments: ExecutionPlanFileAssignment[]): void {
    const resolvedWorkspace = path.resolve(state.workspacePath);

    for (const a of assignments) {
        const file = state.fileRecord[a.fileName];
        if (!file) continue; // defensive — never trust renderer-sourced names blindly

        const baseFolder = resolveBaseFolder(resolvedWorkspace, a.scope, a.extension);
        const candidate = path.resolve(path.join(baseFolder, sanitizeFolderName(a.folderName)));
        if (!candidate.startsWith(resolvedWorkspace)) continue; // containment check, mirrors Finalize tools' existing pattern

        file.category = a.category;
        file.fileNewDestination = candidate;
        file.planConfirmed = true;
    }
}

const getFinalPlanConfirmation = ({
    description: "Prints the complete proposed file movement plan to the UI and asks the user for confirmation. Call this ONLY after finalizing all folders for all extensions. The LLM will receive the user's response to either proceed or make changes.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Let's review the final plan before I move anything...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "statusMessage"]
    },
    async handler(params: {ProcessId: string, statusMessage: string}): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const { scopes, unassignedCount } = buildExecutionPlanRequest(state);

        emitAgentMessage(params.statusMessage);

        // Ask the user for confirmation via the structured, editable execution plan panel
        const response = await requestExecutionPlanConfirmation(scopes, unassignedCount);

        if (response.action === 'approve') {
            applyExecutionPlanResponse(state, response.assignments ?? []);
            state.planConfirmed = true;
            state.planConfirmedFiles = state.fileListData.filter(
                f => f.planConfirmed === true && f.fileNewDestination !== ""
            );
            emitAgentMessage("Got it — moving your files now...");
            return "User confirmed the plan exactly as is. You may proceed to create the folders and execute the move plan.";
        } else {
            state.planConfirmed = false;
            emitAgentMessage("Got it — let me adjust that...");
            return `User did not confirm the plan. This is what user said about the plan : "${response.message ?? 'No reason given.'}". Please adjust the categories/folders as requested by the user using the Finalize tool again, or respond accordingly.`;
        }
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
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do, e.g. 'Moving your files into their new folders now...'. This will be shown directly to the user."
            }
        },
        required: ["ProcessId", "statusMessage"]
    },
    async handler(params: {ProcessId: string, statusMessage: string}): Promise<string> {
        emitLog(`Executetheprocess started`, 'tool_call', 'Executetheprocess');
        emitAgentMessage(params.statusMessage);
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        // Hard stop if plan hasn't been confirmed explicitly
        if (!state.planConfirmed) {
            return "Error: You CANNOT execute the process because the user has not confirmed the plan. You must use getFinalPlanConfirmation and receive explicit user approval first.";
        }

        const foldersToCreate = new Set<string>();
        const filesToMove: fileStatus[] = [];

        // Gather all destinations based on the finalized state
        for(const file of state.planConfirmedFiles){
            if(file.fileNewDestination && file.planConfirmed){
                foldersToCreate.add(file.fileNewDestination);
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
                await mkdir(folder, { recursive: true });
                results.foldersCreated++;
            } catch (e: any) {
                if (e.code !== 'EEXIST') {
                    results.folderErrors.push(`Failed to create folder ${folder}: ${e.message}`);
                }
            }
        }

        // 2. Safely Move Files
        for (const file of filesToMove) {
            try {
                const destPath = path.join(file.fileNewDestination, file.fileName);
                if (!path.resolve(destPath).startsWith(resolvedWorkspacePath)) {
                    results.fileErrors.push(`Failed to move ${file.fileName}: Security Error - Destination path is outside workspace.`);
                    continue;
                }
                await rename(file.filePath, destPath);
                file.isFileSuccessfullyMoved = true;
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

        emitLog(`Execution complete! Folders: ${results.foldersCreated}, Moved: ${results.filesMoved}, Errors: ${results.fileErrors.length}`, 'info', 'Executetheprocess');
        return summary;
    }
});

export const ExecutionTools = {
    getFinalPlanConfirmation,
    Executetheprocess,
    ErrorEncountered
};