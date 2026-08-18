import { fileAgentRecord } from '../src/state/fileAgentState.js';
import { emitAgentMessage, emitLog } from '../electron/ipcBridge.js';

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
            },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do"
            }
        },
        required: ["ProcessId", "statusMessage"]
    },
    async handler(params: { ProcessId: string, statusMessage: string }): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        emitAgentMessage(params.statusMessage, 'system');
        if (!state.todoList || state.todoList.length === 0) {
            return "Error: Cannot hand off — the todo list is empty. Create a todo list first using CreateTodoListTool.";
        }

        state.phase = 'categorization';
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
            },
            NameOfAgent: {
                type: "string",
                description: "The name of the agent you are calling this tool from."
            }
        },
        required: ["ProcessId", "Error", "NameOfAgent"]
    },
    async handler(params: { ProcessId: string, Error: string, NameOfAgent: string }): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        emitAgentMessage(params.Error);
        emitLog('Error Encountered in pipeline', 'error', params.NameOfAgent);
        emitLog(params.Error, 'error', params.NameOfAgent);
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
            },
            statusMessage: {
                type: "string",
                description: "A short, friendly first-person message telling the user what you're about to do."
            }
        },
        required: ["ProcessId", "statusMessage"]
    },
    async handler(params: { ProcessId: string, statusMessage: string }): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        emitAgentMessage(params.statusMessage, 'system');
        const incompleteTasks = state.todoList.filter(
            t => t.status !== 'completed' && t.status !== 'failed'
        );
        if (incompleteTasks.length > 0) {
            const ids = incompleteTasks.map(t => `[${t.id}] ${t.title}`).join(', ');
            return `Error: Cannot hand off — these tasks are not yet completed or failed: ${ids}. Finish all tasks first.`;
        }

        state.phase = 'execution';

        return HANDOFF_EXECUTION_SENTINEL;
    }
});
