import path from "path";
import { fileAgentRecord, fileStatus } from "../src/state/fileAgentState.js";
import { mkdir } from 'node:fs/promises';
import { rename } from 'node:fs/promises'
import { ErrorEncountered } from "./pipelineTools.js";
import { emitAgentMessage, emitLog, requestExecutionConfirmation } from "../electron/ipcBridge.js";

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

        // Group all finalized files by destination folder
        const plan: Record<string, string[]> = {};
        let unassignedCount = state.fileListData.filter(files => files.planConfirmed == false).length;

        const planConfirmedFiles = state.fileListData.filter(files => files.planConfirmed == true && files.fileNewDestination !== "");
        for(const file of planConfirmedFiles){
            if (!plan[file.fileNewDestination]){
                plan[file.fileNewDestination] = [];
            }
            plan[file.fileNewDestination]?.push(file.fileName);
        }

        emitAgentMessage(params.statusMessage);

        // Ask the user for confirmation via the structured execution-confirm panel
        const response = await requestExecutionConfirmation(plan, unassignedCount);

        if (response.action === 'approve') {
            state.planConfirmed = true;
            state.planConfirmedFiles = planConfirmedFiles;
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