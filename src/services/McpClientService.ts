import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { emitAgentMessage, emitLog } from '../../electron/ipcBridge.js';

// ---------------------------------------------------------------------------
// Shared primitive types
// ---------------------------------------------------------------------------

export interface McpKeyword {
    term: string;
    ctfidf_score: number;
}

export interface McpTopicFile {
    name: string;
    relative_path: string;
    absolute_path: string;
    extension: string;
    cluster_probability: number;
}

export interface McpTopic {
    topic_id: number;
    document_count: number;
    keywords: McpKeyword[];
    mean_pairwise_cosine_similarity?: number;
    files: McpTopicFile[];
}

// ---------------------------------------------------------------------------
// evaluate_clustering response
// ---------------------------------------------------------------------------

export interface McpTopicPreview {
    topic_id: number;
    document_count: number;
    top_keywords: string[];
}

export interface McpClusteringMetrics {
    topic_count: number;
    outlier_ratio: number;
    largest_topic_ratio: number;
    mean_topic_cohesion: number;
    mean_cluster_probability: number;
}

export interface McpEvaluationResult {
    status: string;
    run_id: string;
    rating: string;           // "good" | "weak" | "poor"
    score: number;
    concerns: string[];       // e.g. ["HIGH_OUTLIER_RATIO", "TOO_FEW_TOPICS"]
    clustering: McpClusteringMetrics;
    topic_previews: McpTopicPreview[];
    effective_config: Record<string, any>;
    adjustments: Record<string, any>;
    result_ttl_minutes: number;
}

// ---------------------------------------------------------------------------
// get_clustering_result response
// ---------------------------------------------------------------------------

export interface McpFullClusteringResult {
    status: string;
    run_id: string;
    topics: McpTopic[];
    outliers: McpTopicFile[];
    skipped_files: any[];
    effective_config: Record<string, any>;
    evaluation: McpEvaluationResult;
}

// ---------------------------------------------------------------------------
// discard_clustering_result response
// ---------------------------------------------------------------------------

export interface McpDiscardResult {
    status: string;
    run_id: string;
    discarded: boolean;
}

// ---------------------------------------------------------------------------
// MCP tool definition (from listTools)
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

// ---------------------------------------------------------------------------
// McpClientService
// ---------------------------------------------------------------------------

export class McpClientService {
    private static instance: McpClientService | null = null;
    private readonly mcpUrl = 'http://127.0.0.1:8081/mcp';
    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private isConnected = false;

    private constructor() { }

    public static getInstance(): McpClientService {
        if (!McpClientService.instance) {
            McpClientService.instance = new McpClientService();
        }
        return McpClientService.instance;
    }

    // -----------------------------------------------------------------------
    // Connection management
    // -----------------------------------------------------------------------

    public async connect(): Promise<Client> {
        if (this.client && this.isConnected) {
            return this.client;
        }
        emitAgentMessage(`Connecting to MCP server at ${this.mcpUrl}...`, 'system');

        this.client = new Client({
            name: 'assist-file-organizer-client',
            version: '1.0.0'
        });

        this.transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await this.client.connect(this.transport as any);
        this.isConnected = true;

        emitLog(JSON.stringify({
            "message": `Connected to MCP server at ${this.mcpUrl}`
        }), 'mcp', 'McpClientService → MCP Server');
        return this.client;
    }

    private resetConnection(): void {
        this.isConnected = false;
        this.client = null;
        this.transport = null;
    }

    // -----------------------------------------------------------------------
    // Generic helpers
    // -----------------------------------------------------------------------

    /**
     * Low-level passthrough: calls any MCP tool by name and returns the parsed
     * JSON result. Used by the dynamic MCP bridge and by the typed wrappers below.
     */
    public async callMcpTool(toolName: string, args: Record<string, any>): Promise<any> {
        try {
            const client = await this.connect();
            const MCP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — BERTopic can be slow

            emitLog(JSON.stringify({
                "mcpTool": toolName,
                "parameter": args,
            }), 'mcp', `McpClientService → ${toolName}`);

            const response = await client.callTool(
                { name: toolName, arguments: args },
                undefined,
                { timeout: MCP_TIMEOUT_MS }
            );


            if (!response?.content) {
                throw new Error(`Empty response from MCP tool '${toolName}'.`);
            }

            const rawJson = this.extractText(response.content);
            const parsed = JSON.parse(rawJson);
            emitLog(JSON.stringify({
                "mcpTool": toolName,
                "response": parsed,
            }), 'mcp', `McpClientService ← ${toolName}`);

            if (parsed?.status === 'error') {
                const err = parsed.error;
                throw new Error(`MCP error in '${toolName}': ${err?.code ?? ''} ${err?.message ?? ''}`);
            }

            // emitLog(`MCP ← ${toolName}: ${rawJson}`, 'mcp', 'MCPClient');
            return parsed;
        } catch (error: any) {
            this.resetConnection();
            emitLog(`MCP call failed (${toolName}): ${error.message}`, 'error', 'MCPClient');
            throw error;
        }
    }

    /**
     * Fetches the list of available tools from the MCP server.
     * Used by buildMcpBridgeTools() to get live schemas for the sub-agent.
     */
    public async listMcpTools(): Promise<McpToolDefinition[]> {
        const client = await this.connect();

        emitLog(JSON.stringify({
            "mcpTool": "list_mcp_tools",
            "parameter": {},
        }), 'mcp', 'McpClientService → list_mcp_tools');
        const result = await client.listTools();

        emitLog(JSON.stringify({
            "mcpTool": "list_mcp_tools",
            response: result,
        }), 'mcp', 'McpClientService ← list_mcp_tools');
        return (result.tools ?? []).map((t: any) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} }
        }));
    }

    private extractText(content: any): string {
        if (Array.isArray(content)) {
            const textItem = content.find((item: any) => item.type === 'text' && typeof item.text === 'string');
            if (textItem) return textItem.text;
            if (typeof content[0] === 'string') return content[0];
            return JSON.stringify(content);
        }
        if (typeof content === 'string') return content;
        return JSON.stringify(content);
    }

    // -----------------------------------------------------------------------
    // Typed wrappers for the three MCP tools
    // -----------------------------------------------------------------------

    /**
     * FIRST CALL in the clustering workflow.
     * Runs BERTopic and returns compact quality metrics + run_id (no file list).
     */
    public async evaluateClustering(
        folderPath: string,
        extensions: string[],
        strategy?: string,
        overrides?: Record<string, any>
    ): Promise<McpEvaluationResult> {
        const args: Record<string, any> = { folder_path: folderPath, extensions };
        if (strategy) args.strategy = strategy;
        if (overrides) args.overrides = overrides;

        const response = await this.callMcpTool('evaluate_clustering', args) as McpEvaluationResult;
        return response;
    }

    /**
     * SECOND CALL — retrieves the full clustering result for an accepted run_id.
     * Returns complete file-to-topic mapping. This payload can be large — only
     * call this through FetchAndProcessClusteringResultTool so it never enters
     * the agent context directly.
     */
    public async getClusteringResult(runId: string): Promise<McpFullClusteringResult> {
        const response = await this.callMcpTool('get_clustering_result', { run_id: runId }) as McpFullClusteringResult;
        return response;
    }

    /**
     * OPTIONAL cleanup — deletes a rejected or unused clustering run by run_id.
     */
    public async discardClusteringResult(runId: string): Promise<McpDiscardResult> {
        const response = await this.callMcpTool('discard_clustering_result', { run_id: runId }) as McpDiscardResult;
        return response;
    }
}
