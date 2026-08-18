/**
 * MCP Clustering Agent — tools.ts
 *
 * Provides the McpClusteringAgent entry-point tool (called by the CategorizedDocument
 * worker agent) and its inner tool set:
 *
 *   • evaluate_clustering                 — MCP bridge (live schema from server)
 *   • discard_clustering_result           — MCP bridge (live schema from server)
 *   • FetchAndProcessClusteringResultTool — custom: fetches get_clustering_result in-process,
 *                                           runs LLM topic naming, writes state, returns summary
 *   • ReportClusteringCompleteTool        — terminal success tool; signals the inner loop to exit
 *   • ErrorEncountered (from pipelineTools) — shared error tool; returns __ERROR_ENCOUNTERED__
 *                                             which OpenAISession already handles via __ERROR_ exit
 */

import { OpenAISession } from '../src/workerAgent.js';
import { LLMService } from '../src/LLMService.js';
import { McpClientService, type McpToolDefinition } from '../src/services/McpClientService.js';
import { FileClassificationTool } from './fileClassificationTool.js';
import { fileAgentRecord } from '../src/state/fileAgentState.js';
import { mcpClusteringAgentSystemPrompt } from '../src/prompt/fileAgent.js';
import { emitLog, emitAgentMessage } from '../electron/ipcBridge.js';
import { ErrorEncountered, ERROR_ENCOUNTERED, HANDOFF_CATEGORIZATION_SENTINEL } from './pipelineTools.js';

// ---------------------------------------------------------------------------
// In-process completion state — mirrors workerCompletionStatus pattern
// Key: `${ProcessId}_${extension.replaceAll('.', '')}`
// ---------------------------------------------------------------------------

export const clusteringCompletionStatus: Record<string, {
    done: boolean;
    summary: string;
}> = {};

// ---------------------------------------------------------------------------
// Helper: build dynamic MCP bridge tools from the live server schema
// ---------------------------------------------------------------------------

/**
 * Fetches tool definitions from the MCP server and returns lightweight
 * tool-definition objects (matching the { description, params, handler }
 * shape expected by OpenAISession) for the requested tool names.
 *
 * The agent sees the exact same parameter schemas that the MCP server
 * advertises — no manual TypeScript schema maintenance needed.
 * Note: get_clustering_result is intentionally excluded — it is called
 * in-process by FetchAndProcessClusteringResultTool, never by the sub-agent.
 */
async function buildMcpBridgeTools(
    mcpClient: McpClientService,
    toolNames: string[]
): Promise<Record<string, any>> {
    let mcpToolList: McpToolDefinition[] = [];
    try {
        emitAgentMessage(`Getting MCP tools...`, 'system');
        mcpToolList = await mcpClient.listMcpTools();
    } catch (e: any) {
        emitLog(`Failed to list MCP tools for bridge: ${e.message}`, 'error', 'McpClusteringAgent');
    }

    const bridges: Record<string, any> = {};

    for (const name of toolNames) {
        const def = mcpToolList.find(t => t.name === name);
        bridges[name] = {
            description: def?.description ?? `MCP tool: ${name}`,
            params: def?.inputSchema ?? { type: 'object', properties: {} },
            async handler(params: any): Promise<string> {
                try {
                    const result = await mcpClient.callMcpTool(name, params);
                    return JSON.stringify(result);
                } catch (e: any) {
                    return JSON.stringify({ status: 'error', message: e.message });
                }
            }
        };
    }

    return bridges;
}

// ---------------------------------------------------------------------------
// FetchAndProcessClusteringResultTool
// ---------------------------------------------------------------------------

/**
 * Fetches the full clustering result from the MCP server for the accepted
 * run_id, immediately runs the LLM topic-naming pass in-process (so the raw
 * file list never enters the sub-agent's context), writes the folder plan to
 * session state, and returns a compact summary string.
 */
const FetchAndProcessClusteringResultTool = {
    description:
        'Fetches the full clustering result for an accepted run_id, generates meaningful ' +
        'folder names via LLM topic analysis, writes the folder plan to session state, and ' +
        'returns a compact summary (category names + file counts). ' +
        'Call this ONCE after selecting the best evaluate_clustering run. ' +
        'The get_clustering_result MCP call is handled internally — never call it directly.',
    params: {
        type: 'object',
        properties: {
            ProcessId: {
                type: 'string',
                description: 'The unique process id for this session.'
            },
            extension: {
                type: 'string',
                description: 'The file extension being processed, e.g. ".pdf".'
            },
            run_id: {
                type: 'string',
                description: 'The run_id returned by evaluate_clustering that you have accepted.'
            },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message for the user, e.g. "Processing clustering results for PDF files…"'
            }
        },
        required: ['ProcessId', 'extension', 'run_id', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        extension: string;
        run_id: string;
        statusMessage: string;
    }): Promise<string> {

        emitAgentMessage(params.statusMessage, 'system');

        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return 'Error: Invalid ProcessId.';
            if (!state.workspacePath) return 'Error: workspacePath not set in state.';

            const mcpClient = McpClientService.getInstance();

            // Fetch the full result — potentially large, but it never reaches the agent context
            const fullResult = await mcpClient.getClusteringResult(params.run_id);

            if (!fullResult || !fullResult.topics) {
                return `Error: get_clustering_result returned no topics for run_id=${params.run_id}`;
            }

            // Run LLM topic naming in-process — result goes to state, not to agent context
            const categorized = await FileClassificationTool.nameTopicsFromMcpResponse(
                fullResult,
                {
                    processId: params.ProcessId,
                    groupId: `mcp_cluster_${params.ProcessId}_${params.extension}`,
                    label: params.extension
                }
            );

            // Update fileRecord categories
            for (const [folderName, fileNames] of Object.entries(categorized)) {
                for (const fileName of fileNames) {
                    if (state.fileRecord[fileName]) {
                        state.fileRecord[fileName].category = folderName;
                    }
                }
            }

            // Compute and store the folder plan
            const extClean = params.extension.replace('.', '').toLowerCase();
            const baseFolder = `${state.workspacePath}/${extClean}`;
            state.proposedFolderPlan[params.extension] = Object.keys(categorized).map(category => ({
                category,
                folder: `${baseFolder}/${category}`
            }));

            // Build a compact summary — ONLY this reaches the sub-agent context
            const summary: Array<{ category: string; fileCount: number }> = Object.entries(categorized).map(
                ([category, files]) => ({ category, fileCount: files.length })
            );
            const outlierCount = fullResult.outliers?.length ?? 0;

            const compactResult = {
                status: 'success',
                extension: params.extension,
                categoriesCreated: summary,
                outlierCount,
                message:
                    `Folder plan ready: ${summary.length} categorie(s) created for ${params.extension}. ` +
                    `Now call ReportClusteringCompleteTool.`
            };

            return JSON.stringify(compactResult);
        } catch (e: any) {
            emitLog(`FetchAndProcessClusteringResultTool error: ${e.message}`, 'error', 'McpClusteringAgent');
            return `Error fetching and processing clustering result: ${e.message}`;
        }
    }
};

// ---------------------------------------------------------------------------
// ReportClusteringCompleteTool
// ---------------------------------------------------------------------------

/**
 * Terminal success tool for the sub-agent. Writes done=true to the
 * clusteringCompletionStatus record so the outer McpClusteringAgent handler
 * exits its loop, then returns CLUSTERING_COMPLETE_SENTINEL so OpenAISession
 * also exits its inner while-loop immediately.
 */
const ReportClusteringCompleteTool = {
    description:
        'Call this as your LAST action after FetchAndProcessClusteringResultTool succeeds. ' +
        'Signals the parent agent that the MCP clustering workflow is complete and the folder ' +
        'plan is ready in session state. Do NOT call any other tool after this.',
    params: {
        type: 'object',
        properties: {
            ProcessId: {
                type: 'string',
                description: 'The unique process id for this session.'
            },
            extension: {
                type: 'string',
                description: 'The file extension that was processed, e.g. ".pdf".'
            },
            summary: {
                type: 'string',
                description: 'The summary string returned by FetchAndProcessClusteringResultTool.'
            },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message, e.g. "Clustering complete — folder plan is ready."'
            }
        },
        required: ['ProcessId', 'extension', 'summary', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        extension: string;
        summary: string;
        statusMessage: string;
    }): Promise<string> {
        emitAgentMessage(params.statusMessage, 'system');

        // Write completion state — the outer loop reads this to exit cleanly
        const key = `${params.ProcessId}_${params.extension.replaceAll('.', '')}`;
        clusteringCompletionStatus[key] = { done: true, summary: params.summary };

        // Return sentinel so OpenAISession's inner while-loop exits immediately
        return HANDOFF_CATEGORIZATION_SENTINEL;
    }
};

// ErrorEncountered is imported from pipelineTools — no local definition needed.
// It returns ERROR_ENCOUNTERED (__ERROR_ENCOUNTERED__) which starts with __ERROR_
// and is already handled by OpenAISession's exit conditions in workerAgent.ts.

// ---------------------------------------------------------------------------
// McpClusteringAgent  — entry-point tool exposed to CategorizedDocument
// ---------------------------------------------------------------------------

export const McpClusteringAgent = {
    description:
        'Spins up a dedicated MCP clustering sub-agent that connects to the local BERTopic MCP ' +
        'server, evaluates clustering quality (up to 3 attempts), selects the best run, ' +
        'fetches and processes the full result into a folder plan, and returns a compact ' +
        'category summary. Call this FIRST for any document extension before presenting the ' +
        'folder plan to the user.',
    params: {
        type: 'object',
        properties: {
            ProcessId: {
                type: 'string',
                description: 'The unique process id for this session.'
            },
            extension: {
                type: 'string',
                description: 'The file extension to cluster, e.g. ".pdf".'
            },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message shown to the user, e.g. "Starting BERTopic clustering for your PDF files…"'
            }
        },
        required: ['ProcessId', 'extension', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        extension: string;
        statusMessage: string;
    }): Promise<string> {
        emitAgentMessage(params.statusMessage, 'system');

        const state = fileAgentRecord[params.ProcessId];
        if (!state) return 'Error: Invalid ProcessId.';
        if (!state.workspacePath) return 'Error: workspacePath not set in state.';

        // Reset any stale completion state from a previous run for the same key
        const completionKey = `${params.ProcessId}_${params.extension.replaceAll('.', '')}`;
        delete clusteringCompletionStatus[completionKey];

        const llmService = await LLMService.getInstance();
        const mcpClient = McpClientService.getInstance();

        return new Promise<string>(async (resolve) => {
            try {
                // Build the sub-agent session
                const session = new OpenAISession(
                    llmService,
                    mcpClusteringAgentSystemPrompt(params.extension, state.workspacePath)
                );

                // Build dynamic MCP bridge tools for evaluate_clustering and discard_clustering_result.
                // get_clustering_result is intentionally excluded — it is called in-process by
                // FetchAndProcessClusteringResultTool and must never be exposed to the sub-agent.
                const mcpBridgeTools = await buildMcpBridgeTools(mcpClient, [
                    'evaluate_clustering',
                    'discard_clustering_result'
                ]);

                const subAgentTools = {
                    ...mcpBridgeTools,
                    FetchAndProcessClusteringResultTool,
                    ReportClusteringCompleteTool,
                    ErrorEncountered
                };

                // Single prompt call — workerAgent.ts already loops internally through every tool
                // call in sequence until a sentinel fires. The full clustering workflow
                // (evaluate \u2192 refine \u2192 fetch \u2192 report complete) completes inside this one call
                // with no user-interaction pauses that would require a follow-up prompt.
                const response = await session.prompt(
                    `Start the MCP clustering workflow for extension "${params.extension}" ` +
                    `in folder "${state.workspacePath}". ProcessId = ${params.ProcessId}.`,
                    { functions: subAgentTools, forceToolUse: true },
                    'MCP Clustering Agent'
                );

                // ErrorEncountered returns __ERROR_ENCOUNTERED__ (__ERROR_ prefix), which
                // OpenAISession exits on immediately and returns. Propagate to the parent.
                if (response.includes(ERROR_ENCOUNTERED)) {
                    resolve(`Error: MCP clustering failed for ${params.extension}.`);
                    return;
                }

                // ReportClusteringCompleteTool writes to clusteringCompletionStatus and returns
                // __CLUSTERING_COMPLETE__ (__CLUSTERING_ prefix), which OpenAISession also exits
                // on immediately. Read the summary from state.
                const status = clusteringCompletionStatus[completionKey];
                if (!status?.done) {
                    resolve(`Error: MCP clustering sub-agent for ${params.extension} did not signal completion.`);
                    return;
                }

                resolve(`MCP clustering complete for ${params.extension}. ${status.summary}`);

            } catch (e: any) {
                emitLog(`McpClusteringAgent error: ${e.message}`, 'error', 'McpClusteringAgent');
                resolve(`Error: MCP clustering sub-agent failed — ${e.message}`);
            }
        });
    }
};
