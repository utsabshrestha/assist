import { fileAgentRecord } from '../src/state/fileAgentState.js';
import { emitLog } from '../electron/ipcBridge.js';

/**
 * Sentinel prefixes detected by OpenAISession.prompt() to break the React loop.
 * Returned as the tool result so the loop exits immediately after the tool call.
 */
export const HANDOFF_CATEGORIZATION_SENTINEL = "__HANDOFF_CATEGORIZATION__";
export const HANDOFF_EXECUTION_SENTINEL = "__HANDOFF_EXECUTION__";
export const ERROR_ENCOUNTERED = "__ERROR_ENCOUNTERED__";

export const HandOffToCategorizationAgent = ({
    description: "Call this tool ONLY when you have: (1) obtained the folder summary, (2) discussed scope with the user, (3) created the todo list, and (4) recorded all user constraints in the scratchpad. Calling this tool signals that planning is complete and hands control to the Categorization Agent. After calling this tool, your job is done — do not call any other tools.",
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
    async handler(params: { ProcessId: string }): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        if (!state.todoList || state.todoList.length === 0) {
            return "Error: Cannot hand off — the todo list is empty. Create a todo list first using ManageTodoListTool.";
        }

        state.phase = 'categorization';
        emitLog('Planning complete. Handing off to Categorization Agent...', 'pipeline');
        return HANDOFF_CATEGORIZATION_SENTINEL;
    }
});

export const ErrorEncountered = ({
    description: "Call this tool when you encountered any kind of error while calling other tools or executing the workflow.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            },
            Error: {
                type: "string",
                description: "The error message you have encountered."
            }
        },
        required: ["ProcessId"]
    },
    async handler(params: { ProcessId: string, Error: string }): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        emitLog('Error Encountered in pipeline', 'error');
        emitLog(params.Error, 'error');
        return ERROR_ENCOUNTERED;
    }
});

export const HandOffToExecutionAgent = ({
    description: "Call this tool ONLY when ALL tasks in the todo list have been updated to 'completed' or 'failed' status. This signals that categorization is complete and hands control to the Execution Agent to show the final plan and execute it. After calling this tool, your job is done — do not call any other tools.",
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
    async handler(params: { ProcessId: string }): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";

        const incompleteTasks = state.todoList.filter(
            t => t.status !== 'completed' && t.status !== 'failed'
        );
        if (incompleteTasks.length > 0) {
            const ids = incompleteTasks.map(t => `[${t.id}] ${t.title}`).join(', ');
            return `Error: Cannot hand off — these tasks are not yet completed or failed: ${ids}. Finish all tasks first.`;
        }

        state.phase = 'execution';
        emitLog('Categorization complete. Handing off to Execution Agent...', 'pipeline');
        return HANDOFF_EXECUTION_SENTINEL;
    }
});
