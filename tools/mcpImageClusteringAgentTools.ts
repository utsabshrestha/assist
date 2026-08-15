/**
 * MCP Image Clustering Agent — tools.ts
 *
 * Provides the McpImageClusteringAgent entry-point tool (called by the
 * ImageCategorizationAgent worker) and its inner tool set:
 *
 *   • GetImageDescriptionsTool              — calls LLM vision for each image,
 *                                             stores descriptions in-process
 *   • EvaluateImageDescriptionClusteringTool — custom MCP bridge: reads
 *                                             descriptions from store, calls
 *                                             evaluate_image_description_clustering,
 *                                             returns compact evaluation only
 *   • FetchAndStoreImageClusteringResultTool — calls get_clustering_result
 *                                             in-process, stores full result
 *   • ProcessImageClusteringResultTool      — LLM topic naming + dedup,
 *                                             writes folder plan to state
 *   • discard_clustering_result             — MCP bridge (live schema)
 *   • ReportImageClusteringCompleteTool     — terminal success sentinel
 *   • ErrorEncountered (from pipelineTools) — shared error sentinel
 */

import * as path from 'path';
import * as crypto from 'crypto';

import { OpenAISession } from '../src/workerAgent.js';
import { LLMService } from '../src/LLMService.js';
import { McpClientService, type McpToolDefinition, type McpFullClusteringResult } from '../src/services/McpClientService.js';
import { ClassificationUtility, extractTaggedOutput, repairTaggedOutput } from '../src/utils/classificationUtility.js';
import { getLowResBase64Image } from '../src/utils/imageUtility.js';
import { fileAgentRecord } from '../src/state/fileAgentState.js';
import { imageDescriptionPrompt, fileCategorizationPrompt, mcpImageClusteringAgentSystemPrompt } from '../src/prompt/fileAgent.js';
import { emitLog, emitAgentMessage } from '../electron/ipcBridge.js';
import { ErrorEncountered, ERROR_ENCOUNTERED, HANDOFF_CATEGORIZATION_SENTINEL } from './pipelineTools.js';
import * as fs from 'node:fs/promises';
// ---------------------------------------------------------------------------
// Per-run in-process state
// ---------------------------------------------------------------------------

/** Image description record as required by evaluate_image_description_clustering */
interface ImageDescriptionRecord {
    image_id: string;
    name: string;
    absolute_path: string;
    relative_path?: string;
    description: string;
}

/**
 * Temporary descriptions store.
 * Key: `${ProcessId}_task_${TaskId}`
 * Populated by GetImageDescriptionsTool, consumed by EvaluateImageDescriptionClusteringTool.
 * Cleared by ProcessImageClusteringResultTool after topic naming is done.
 */
const imageDescriptionsStore = new Map<string, ImageDescriptionRecord[]>();

/**
 * Temporary raw MCP clustering result store.
 * Key: `${ProcessId}_task_${TaskId}`
 * Populated by FetchAndStoreImageClusteringResultTool, consumed by ProcessImageClusteringResultTool.
 * Cleared by ProcessImageClusteringResultTool after processing.
 */
const imageClusteringResultStore = new Map<string, McpFullClusteringResult>();

/**
 * Completion status — mirrors clusteringCompletionStatus in mcpClusteringAgentTools.ts.
 * Key: `${ProcessId}_task_${TaskId}`
 */
export const imageClusteringCompletionStatus: Record<string, {
    done: boolean;
    summary: string;
}> = {};

// ---------------------------------------------------------------------------
// Helper: build dynamic MCP bridge tools from live server schema
// ---------------------------------------------------------------------------

async function buildMcpBridgeTools(
    mcpClient: McpClientService,
    toolNames: string[]
): Promise<Record<string, any>> {
    let mcpToolList: McpToolDefinition[] = [];
    try {
        mcpToolList = await mcpClient.listMcpTools();
    } catch (e: any) {
        emitLog(`Failed to list MCP tools for bridge: ${e.message}`, 'error', 'McpImageClusteringAgent');
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
// Tool 1 — GetImageDescriptionsTool
// ---------------------------------------------------------------------------

const GetImageDescriptionsTool = {
    description:
        'Generates a natural-language description for every unprocessed image in this task using ' +
        'the LLM vision capability. Descriptions are stored in-process — they are NOT returned to ' +
        'you. Call this FIRST before any MCP tool. Returns { status, imageCount } only.',
    params: {
        type: 'object',
        properties: {
            ProcessId: { type: 'string', description: 'The unique process id for this session.' },
            TaskId: { type: 'number', description: 'The Task Id of the todo list item being organized.' },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message for the user, e.g. "Describing your images with AI vision..."'
            }
        },
        required: ['ProcessId', 'TaskId', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        TaskId: number;
        statusMessage: string;
    }): Promise<string> {
        emitLog(
            `GetImageDescriptionsTool → ProcessId=${params.ProcessId} TaskId=${params.TaskId}`,
            'tool_call',
            'McpImageClusteringAgent'
        );
        emitAgentMessage(params.statusMessage);

        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return 'Error: Invalid ProcessId.';
            if (!state.workspacePath) return 'Error: workspacePath not set in state.';

            const llmService = await LLMService.getInstance();

            // Collect all unprocessed image files for extensions in this task
            const extensions: string[] = state.todoList
                .filter(t => t.id === params.TaskId)
                .flatMap(t => t.extensionList);

            const allImagePaths: string[] = [];
            for (const ext of extensions) {
                const files = state.fileByExtension[ext];
                if (files && files.length > 0) {
                    const unprocessed = files.filter(x => x.planConfirmed === false);
                    for (const file of unprocessed) {
                        allImagePaths.push(path.join(state.workspacePath, file.fileName));
                    }
                }
            }

            if (allImagePaths.length === 0) {
                return JSON.stringify({ status: 'error', message: 'No unprocessed image files found for this task.' });
            }

            emitAgentMessage(
                `Describing ${allImagePaths.length} images...`,
                'task_update',
                `img_desc_${params.ProcessId}_${params.TaskId}`
            );
            emitLog(
                `GetImageDescriptionsTool: describing ${allImagePaths.length} images sequentially`,
                'pipeline',
                'McpImageClusteringAgent'
            );

            const descriptions: ImageDescriptionRecord[] = [];

            // const appRoot = process.cwd();
            // const filePath = path.join(appRoot, 'imagedata.json');
            // const rawData = await fs.readFile(filePath, 'utf-8');
            // const imagedata: any = JSON.parse(rawData);

            // if (imagedata["data"] != undefined) {
            //     const storeKey = `${params.ProcessId}_task_${params.TaskId}`;
            //     imageDescriptionsStore.set(storeKey, imagedata["data"]);
            //     return JSON.stringify({
            //         status: 'ready',
            //         imageCount: imagedata["data"].length,
            //         message: 'Descriptions generated and stored. Call EvaluateImageDescriptionClusteringTool next.'
            //     });
            // }

            for (const [i, absolutePath] of allImagePaths.entries()) {
                const fileName = path.basename(absolutePath);
                const relativePath = path.relative(state.workspacePath, absolutePath);
                // Stable, unique image_id within this batch
                const image_id = crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 16);

                let description = fileName; // Fallback to filename

                try {
                    const base64 = await getLowResBase64Image(absolutePath, 256);

                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            {
                                role: 'system',
                                content: imageDescriptionPrompt + "\n\nRespond ONLY with a valid JSON object containing a 'description' string property."
                            },
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'image_url',
                                        image_url: { url: `data:image/jpeg;base64,${base64}` }
                                    },
                                    {
                                        type: 'text',
                                        text: `Describe this image. File name: ${fileName}`
                                    }
                                ]
                            }
                        ],
                        temperature: 0.1,
                        response_format: {
                            type: 'json_schema',
                            json_schema: {
                                name: 'image_description',
                                strict: true,
                                schema: {
                                    type: 'object',
                                    properties: {
                                        description: { type: 'string' }
                                    },
                                    required: ['description'],
                                    additionalProperties: false
                                }
                            }
                        }
                    });

                    const rawOutput = response.choices[0]?.message?.content || '';
                    try {
                        const parsed = JSON.parse(rawOutput);
                        if (parsed.description && parsed.description.trim().length > 0) {
                            description = parsed.description.trim();
                        }
                    } catch {
                        description = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || fileName;
                    }

                    emitLog(
                        `Described ${i + 1}/${allImagePaths.length}: ${fileName} → "${description.substring(0, 80)}..."`,
                        'tool_result',
                        'McpImageClusteringAgent'
                    );
                } catch (err: any) {
                    emitLog(`Failed to describe ${fileName}: ${err.message}`, 'error', 'McpImageClusteringAgent');
                    // Use filename as fallback so we still have an entry
                }

                descriptions.push({
                    image_id,
                    name: fileName,
                    absolute_path: absolutePath,
                    relative_path: relativePath,
                    description
                });
            }

            // Store in-process — never returned to sub-agent
            const storeKey = `${params.ProcessId}_task_${params.TaskId}`;
            imageDescriptionsStore.set(storeKey, descriptions);

            emitLog(
                `GetImageDescriptionsTool: stored ${descriptions.length} descriptions for key "${storeKey}"`,
                'tool_result',
                'McpImageClusteringAgent'
            );

            return JSON.stringify({
                status: 'ready',
                imageCount: descriptions.length,
                message: 'Descriptions generated and stored. Call EvaluateImageDescriptionClusteringTool next.'
            });

        } catch (e: any) {
            emitLog(`GetImageDescriptionsTool error: ${e.message}`, 'error', 'McpImageClusteringAgent');
            return `Error generating image descriptions: ${e.message}`;
        }
    }
};

// ---------------------------------------------------------------------------
// Tool 2 — EvaluateImageDescriptionClusteringTool
// (custom wrapper — descriptions injected from store, never from agent params)
// ---------------------------------------------------------------------------

const EvaluateImageDescriptionClusteringTool = {
    description:
        'Sends the pre-generated image descriptions to the MCP BERTopic server for clustering. ' +
        'Descriptions are read from in-process storage — do NOT pass them yourself. ' +
        'Returns compact quality metrics (rating, score, concerns, topic_previews) and a run_id. ' +
        'Start with strategy="auto". Call at most 3 times total.',
    params: {
        type: 'object',
        properties: {
            ProcessId: { type: 'string', description: 'The unique process id for this session.' },
            TaskId: { type: 'number', description: 'The Task Id being organized.' },
            strategy: {
                type: 'string',
                description: 'Clustering strategy. One of: auto, balanced, small_collection, more_specific_topics, fewer_broader_topics, strict_high_confidence. Default: auto.',
                enum: ['auto', 'balanced', 'small_collection', 'more_specific_topics', 'fewer_broader_topics', 'strict_high_confidence']
            },
            overrides: {
                type: 'object',
                description: 'Optional bounded advanced settings. Use only to respond to a specific diagnostic: min_topic_size, top_terms, umap_n_neighbors, hdbscan_min_cluster_size, hdbscan_cluster_selection_method.',
                properties: {}
            },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message for the user, e.g. "Clustering your images with BERTopic..."'
            }
        },
        required: ['ProcessId', 'TaskId', 'statusMessage', 'strategy']
    },
    async handler(params: {
        ProcessId: string;
        TaskId: number;
        strategy?: string;
        overrides?: Record<string, any>;
        statusMessage: string;
    }): Promise<string> {
        emitLog(
            `EvaluateImageDescriptionClusteringTool → ProcessId=${params.ProcessId} TaskId=${params.TaskId} strategy=${params.strategy ?? 'auto'}`,
            'tool_call',
            'McpImageClusteringAgent'
        );
        emitAgentMessage(params.statusMessage);

        try {
            const storeKey = `${params.ProcessId}_task_${params.TaskId}`;
            const descriptions = imageDescriptionsStore.get(storeKey);

            if (!descriptions || descriptions.length === 0) {
                return 'Error: No image descriptions found in store. Call GetImageDescriptionsTool first.';
            }

            const mcpClient = McpClientService.getInstance();

            // Build the MCP payload — inject descriptions from store, not from agent args
            const mcpArgs: Record<string, any> = {
                images: descriptions.map(d => ({
                    image_id: d.image_id,
                    name: d.name,
                    absolute_path: d.absolute_path,
                    ...(d.relative_path ? { relative_path: d.relative_path } : {}),
                    description: d.description
                })),
                strategy: params.strategy ?? 'auto'
            };
            if (params.overrides) mcpArgs.overrides = params.overrides;

            emitLog(
                `Calling evaluate_image_description_clustering: ${descriptions.length} images, strategy=${mcpArgs.strategy}`,
                'pipeline',
                'McpImageClusteringAgent'
            );

            const evaluation = await mcpClient.callMcpTool('evaluate_image_description_clustering', mcpArgs);

            if (!evaluation || evaluation.status === 'error') {
                return JSON.stringify({
                    status: 'error',
                    message: evaluation?.error?.message ?? 'evaluate_image_description_clustering failed.'
                });
            }

            emitLog(
                `evaluate_image_description_clustering: rating=${evaluation.evaluation?.rating ?? 'N/A'}, score=${evaluation.evaluation?.score ?? 'N/A'}, run_id=${evaluation.run_id}`,
                'tool_result',
                'McpImageClusteringAgent'
            );

            // Return the compact evaluation — safe to pass to sub-agent (no file lists)
            return JSON.stringify(evaluation);

        } catch (e: any) {
            emitLog(`EvaluateImageDescriptionClusteringTool error: ${e.message}`, 'error', 'McpImageClusteringAgent');
            return `Error calling evaluate_image_description_clustering: ${e.message}`;
        }
    }
};

// ---------------------------------------------------------------------------
// Tool 3 — FetchAndStoreImageClusteringResultTool
// ---------------------------------------------------------------------------

const FetchAndStoreImageClusteringResultTool = {
    description:
        'Fetches the full clustering result for an accepted run_id from the MCP server and stores ' +
        'it in-process. The full result (file lists, descriptions, probabilities) is NEVER returned ' +
        'to you — it is stored internally for ProcessImageClusteringResultTool. ' +
        'Returns only { status, topicCount, topicSizes } to keep your context small. ' +
        'Call this ONCE after selecting the best evaluate_image_description_clustering run.',
    params: {
        type: 'object',
        properties: {
            ProcessId: { type: 'string', description: 'The unique process id for this session.' },
            TaskId: { type: 'number', description: 'The Task Id being organized.' },
            run_id: {
                type: 'string',
                description: 'The run_id returned by EvaluateImageDescriptionClusteringTool that you have accepted.'
            },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message for the user, e.g. "Retrieving clustering results..."'
            }
        },
        required: ['ProcessId', 'TaskId', 'run_id', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        TaskId: number;
        run_id: string;
        statusMessage: string;
    }): Promise<string> {
        emitLog(
            `FetchAndStoreImageClusteringResultTool → ProcessId=${params.ProcessId} TaskId=${params.TaskId} run_id=${params.run_id}`,
            'tool_call',
            'McpImageClusteringAgent'
        );
        emitAgentMessage(params.statusMessage);

        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return 'Error: Invalid ProcessId.';

            const mcpClient = McpClientService.getInstance();

            // Fetch full result — potentially large, never reaches sub-agent context
            const fullResult = await mcpClient.getClusteringResult(params.run_id);

            if (!fullResult || !fullResult.topics) {
                return `Error: get_clustering_result returned no topics for run_id=${params.run_id}`;
            }

            const storeKey = `${params.ProcessId}_task_${params.TaskId}`;
            imageClusteringResultStore.set(storeKey, fullResult);

            const topicSizes = fullResult.topics.map(t => ({
                topic_id: t.topic_id,
                imageCount: t.document_count
            }));
            const outlierCount = fullResult.outliers?.length ?? 0;

            emitLog(
                `FetchAndStore: stored ${fullResult.topics.length} topic(s), ${outlierCount} outlier(s) for key "${storeKey}"`,
                'tool_result',
                'McpImageClusteringAgent'
            );

            return JSON.stringify({
                status: 'stored',
                topicCount: fullResult.topics.length,
                topicSizes,
                outlierCount,
                message: 'Full result stored in-process. Call ProcessImageClusteringResultTool next.'
            });

        } catch (e: any) {
            emitLog(`FetchAndStoreImageClusteringResultTool error: ${e.message}`, 'error', 'McpImageClusteringAgent');
            return `Error fetching clustering result: ${e.message}`;
        }
    }
};

// ---------------------------------------------------------------------------
// Tool 4 — ProcessImageClusteringResultTool
// ---------------------------------------------------------------------------

const ProcessImageClusteringResultTool = {
    description:
        'Reads the stored clustering result, names each topic via LLM (using c-TF-IDF keywords ' +
        'and representative image descriptions for richer naming), deduplicates category names, ' +
        'writes the folder plan to session state, and returns a compact summary. ' +
        'Call this ONCE after FetchAndStoreImageClusteringResultTool succeeds.',
    params: {
        type: 'object',
        properties: {
            ProcessId: { type: 'string', description: 'The unique process id for this session.' },
            TaskId: { type: 'number', description: 'The Task Id being organized.' },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message for the user, e.g. "Naming image categories..."'
            }
        },
        required: ['ProcessId', 'TaskId', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        TaskId: number;
        statusMessage: string;
    }): Promise<string> {
        emitLog(
            `ProcessImageClusteringResultTool → ProcessId=${params.ProcessId} TaskId=${params.TaskId}`,
            'tool_call',
            'McpImageClusteringAgent'
        );
        emitAgentMessage(params.statusMessage);

        try {
            const state = fileAgentRecord[params.ProcessId];
            if (!state) return 'Error: Invalid ProcessId.';
            if (!state.workspacePath) return 'Error: workspacePath not set in state.';

            const storeKey = `${params.ProcessId}_task_${params.TaskId}`;
            const fullResult = imageClusteringResultStore.get(storeKey);

            if (!fullResult) {
                return 'Error: No clustering result found in store. Call FetchAndStoreImageClusteringResultTool first.';
            }

            const llmService = await LLMService.getInstance();
            const topics = fullResult.topics || [];
            const result: Record<string, string[]> = {};
            const groupId = `img_process_${params.ProcessId}_${params.TaskId}`;

            emitAgentMessage(`Naming ${topics.length} image group(s)...`, 'task_update', groupId);
            emitLog(
                `ProcessImageClusteringResultTool: naming ${topics.length} topic(s)`,
                'pipeline',
                'McpImageClusteringAgent'
            );

            for (let i = 0; i < topics.length; i++) {
                const topic = topics[i];
                if (!topic) continue;

                // Images in this topic — the full result includes description on each image
                const topicImages: any[] = topic.files ?? (topic as any).images ?? [];
                const fileNames: string[] = topicImages.map((img: any) =>
                    img.name || path.basename(img.absolute_path)
                );
                const keywordList: string[] = (topic.keywords || []).map((k: any) => k.term);

                if (topic.topic_id === -1) {
                    result['Uncategorized'] = (result['Uncategorized'] || []).concat(fileNames);
                    continue;
                }

                // Build naming prompt: c-TF-IDF keywords + image descriptions of representative images
                const keywordsText = keywordList.length > 0
                    ? keywordList.map((kw: string, idx: number) => {
                        const scoreVal = topic.keywords[idx]?.ctfidf_score;
                        return scoreVal !== undefined
                            ? `${kw} [${typeof scoreVal === 'number' ? scoreVal.toFixed(2) : scoreVal}]`
                            : kw;
                    }).join(', ')
                    : '(no distinctive keywords extracted)';

                // Use up to 4 representative images with their descriptions
                const repImages = topicImages.slice(0, 4);
                const repLines = repImages.map((img: any, idx: number) => {
                    const positionTag = ClassificationUtility.describeRepresentativePosition(idx, repImages.length);
                    const desc = img.description
                        ? ` — "${img.description.substring(0, 120)}"`
                        : '';
                    return `[${positionTag}] ${img.name || path.basename(img.absolute_path)}${desc}`;
                }).join('\n');

                const allFilesNote = fileNames.length > repImages.length
                    ? `\n\nAll ${fileNames.length} images in this group: ${fileNames.join(', ')}`
                    : '';

                const prompt =
                    `These images belong to the same visual group:\n` +
                    `Distinctive keywords (c-TF-IDF ranked): ${keywordsText}\n\n` +
                    `Representative images:\n${repLines}${allFilesNote}\n\n` +
                    `Folder name:`;

                const response = await llmService.openai.chat.completions.create({
                    model: llmService.modelName,
                    messages: [
                        { role: 'system', content: fileCategorizationPrompt },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2,
                    // @ts-ignore — llama.cpp passthrough extra
                    cache_prompt: false,
                    max_tokens: 1800,
                    // @ts-ignore — llama.cpp passthrough extra
                    repeat_penalty: 1.1,
                });

                const message: any = response.choices[0]?.message;
                emitLog(
                    `Image topic ${topic.topic_id} prompt:\n${prompt}\n\nRaw model output:\n${JSON.stringify(message, null, 2)}`,
                    'tool_call',
                    'McpImageClusteringAgent'
                );

                let folderName = extractTaggedOutput(message);
                if (!folderName) {
                    const finishReason = response.choices[0]?.finish_reason;
                    const rawText = message?.content || message?.reasoning_content || '';
                    emitLog(
                        `Image topic ${topic.topic_id}: no <output> tag found (finish_reason=${finishReason}, ${rawText.length} chars), attempting repair`,
                        'tool_result',
                        'McpImageClusteringAgent'
                    );
                    folderName = await repairTaggedOutput(rawText, llmService) || `Image_Category_${topic.topic_id}`;
                }

                let cleanFolderName = (folderName.trim()
                    .replace(/^["']|["']$/g, '')
                    .replace(/[/\\?%*:|"<>]/g, '-')
                    .split('\n')[0] ?? '').trim();

                if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === 'undefined') {
                    cleanFolderName = `Image_Category_${topic.topic_id}`;
                }

                const reasoningPreview = (message?.content || message?.reasoning_content || '')
                    .replace(/<output>[\s\S]*?<\/output>/i, '')
                    .trim();

                emitLog(
                    `Image topic ${topic.topic_id} (${fileNames.length} images) → "${cleanFolderName}"\n` +
                    `Keywords: ${keywordsText}\n` +
                    `Sample images: ${fileNames.slice(0, 5).join(', ')}${fileNames.length > 5 ? '...' : ''}\n` +
                    `Reasoning: ${reasoningPreview || '(repaired)'}`,
                    'tool_result',
                    'McpImageClusteringAgent'
                );

                result[cleanFolderName] = (result[cleanFolderName] || []).concat(fileNames);
            }

            // Handle outliers from MCP
            if (fullResult.outliers && fullResult.outliers.length > 0) {
                const outlierNames = fullResult.outliers.map((f: any) =>
                    typeof f === 'string' ? path.basename(f) : f.name || path.basename(f.absolute_path)
                );
                result['Uncategorized'] = (result['Uncategorized'] || []).concat(outlierNames);
            }

            // Deduplicate similar category names (same as imageClassificationTool.ts Step 5)
            const folderNames = Object.keys(result);
            if (folderNames.length > 1) {
                emitLog('Checking for similar image category names to deduplicate...', 'pipeline', 'McpImageClusteringAgent');
                const merges = await ClassificationUtility.deduplicateCategories(folderNames, llmService);
                if (merges.length > 0) {
                    emitLog(`Merged ${merges.length} similar image categories`, 'tool_result', 'McpImageClusteringAgent');
                    for (const merge of merges) {
                        if (result[merge.source] && result[merge.target] && merge.source !== merge.target) {
                            result[merge.target] = (result[merge.target] as string[]).concat(result[merge.source] as string[]);
                            delete result[merge.source];
                        } else if (result[merge.source] && !result[merge.target]) {
                            result[merge.target] = result[merge.source] as string[];
                            delete result[merge.source];
                        }
                    }
                }
            }

            // Write categories to fileRecord state
            for (const [folderName, fileNames] of Object.entries(result)) {
                for (const fileName of fileNames) {
                    if (state.fileRecord[fileName]) {
                        state.fileRecord[fileName].category = folderName;
                    }
                }
            }

            // Write the folder plan — keyed by TaskId (same as current GetCategoriesOfImages)
            const baseFolder = `${state.workspacePath}/Images`;
            state.proposedFolderPlan[`__task_${params.TaskId}`] = Object.keys(result).map(category => ({
                category,
                folder: `${baseFolder}/${category}`
            }));

            // Clean up in-process stores for this key
            imageDescriptionsStore.delete(storeKey);
            imageClusteringResultStore.delete(storeKey);

            emitLog(
                `ProcessImageClusteringResultTool complete: ${Object.keys(result).length} categories for Task ${params.TaskId}`,
                'tool_result',
                'McpImageClusteringAgent'
            );

            // Compact summary returned to sub-agent
            const summary = Object.entries(result).map(([name, files]) => ({
                category: name,
                imageCount: files.length
            }));
            const outlierCount = result['Uncategorized']?.length ?? 0;

            return JSON.stringify({
                status: 'success',
                categoriesCreated: summary,
                outlierCount,
                message: `Folder plan ready: ${summary.length} category/categories created. Now call ReportImageClusteringCompleteTool.`
            });

        } catch (e: any) {
            emitLog(`ProcessImageClusteringResultTool error: ${e.message}`, 'error', 'McpImageClusteringAgent');
            return `Error processing clustering result: ${e.message}`;
        }
    }
};

// ---------------------------------------------------------------------------
// Tool 5 — ReportImageClusteringCompleteTool
// ---------------------------------------------------------------------------

const ReportImageClusteringCompleteTool = {
    description:
        'Call this as your LAST action after ProcessImageClusteringResultTool succeeds. ' +
        'Signals the parent agent that the MCP image clustering workflow is complete and the folder ' +
        'plan is ready in session state. Do NOT call any other tool after this.',
    params: {
        type: 'object',
        properties: {
            ProcessId: { type: 'string', description: 'The unique process id for this session.' },
            TaskId: { type: 'number', description: 'The Task Id that was processed.' },
            summary: {
                type: 'string',
                description: 'The summary string returned by ProcessImageClusteringResultTool.'
            },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message, e.g. "Image clustering complete — folder plan is ready."'
            }
        },
        required: ['ProcessId', 'TaskId', 'summary', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        TaskId: number;
        summary: string;
        statusMessage: string;
    }): Promise<string> {
        emitLog(
            `ReportImageClusteringCompleteTool → ProcessId=${params.ProcessId} TaskId=${params.TaskId}`,
            'tool_call',
            'McpImageClusteringAgent'
        );
        emitAgentMessage(params.statusMessage);

        const key = `${params.ProcessId}_task_${params.TaskId}`;
        imageClusteringCompletionStatus[key] = { done: true, summary: params.summary };

        return HANDOFF_CATEGORIZATION_SENTINEL;
    }
};

// ---------------------------------------------------------------------------
// McpImageClusteringAgent — entry-point exposed to ImageCategorizationAgent
// ---------------------------------------------------------------------------

export const McpImageClusteringAgent = {
    description:
        'Spins up a dedicated MCP image clustering sub-agent that: (1) describes all images via ' +
        'LLM vision, (2) sends descriptions to the BERTopic MCP server for clustering (up to 3 ' +
        'strategy attempts), (3) fetches and stores the full result in-process, (4) names topics ' +
        'via LLM using c-TF-IDF keywords + image descriptions, (5) deduplicates categories, and ' +
        '(6) writes the folder plan to session state. Returns a compact category summary. ' +
        'Call this FIRST for the image task — replaces GetCategoriesOfImages.',
    params: {
        type: 'object',
        properties: {
            ProcessId: { type: 'string', description: 'The unique process id for this session.' },
            TaskId: { type: 'number', description: 'The Task Id of the todo list item being organized.' },
            statusMessage: {
                type: 'string',
                description: 'Short first-person status message shown to the user, e.g. "Starting BERTopic image clustering..."'
            }
        },
        required: ['ProcessId', 'TaskId', 'statusMessage']
    },
    async handler(params: {
        ProcessId: string;
        TaskId: number;
        statusMessage: string;
    }): Promise<string> {
        emitLog(
            `McpImageClusteringAgent → ProcessId=${params.ProcessId} TaskId=${params.TaskId}`,
            'tool_call',
            'McpImageClusteringAgent'
        );
        emitAgentMessage(params.statusMessage);

        const state = fileAgentRecord[params.ProcessId];
        if (!state) return 'Error: Invalid ProcessId.';
        if (!state.workspacePath) return 'Error: workspacePath not set in state.';

        // Reset any stale completion state and in-process stores for this key
        const completionKey = `${params.ProcessId}_task_${params.TaskId}`;
        delete imageClusteringCompletionStatus[completionKey];

        const storeKey = `${params.ProcessId}_task_${params.TaskId}`;
        imageDescriptionsStore.delete(storeKey);
        imageClusteringResultStore.delete(storeKey);

        const llmService = await LLMService.getInstance();
        const mcpClient = McpClientService.getInstance();

        return new Promise<string>(async (resolve) => {
            try {
                const session = new OpenAISession(
                    llmService,
                    mcpImageClusteringAgentSystemPrompt(params.TaskId, state.workspacePath)
                );

                // Build dynamic MCP bridge for discard_clustering_result only.
                // evaluate_image_description_clustering is handled by EvaluateImageDescriptionClusteringTool (custom wrapper).
                // get_clustering_result is handled by FetchAndStoreImageClusteringResultTool.
                const mcpBridgeTools = await buildMcpBridgeTools(mcpClient, [
                    'discard_clustering_result'
                ]);

                const subAgentTools = {
                    GetImageDescriptionsTool,
                    EvaluateImageDescriptionClusteringTool,
                    FetchAndStoreImageClusteringResultTool,
                    ProcessImageClusteringResultTool,
                    ...mcpBridgeTools,        // discard_clustering_result
                    ReportImageClusteringCompleteTool,
                    ErrorEncountered
                };

                const response = await session.prompt(
                    `Start the MCP image clustering workflow for Task ${params.TaskId} ` +
                    `in folder "${state.workspacePath}". ProcessId = ${params.ProcessId}.`,
                    { functions: subAgentTools, forceToolUse: true }
                );
                emitLog(response, 'info', 'McpImageClusteringAgent');

                if (response.includes(ERROR_ENCOUNTERED)) {
                    resolve(`Error: MCP image clustering failed for Task ${params.TaskId}.`);
                    return;
                }

                const status = imageClusteringCompletionStatus[completionKey];
                if (!status?.done) {
                    resolve(`Error: MCP image clustering sub-agent for Task ${params.TaskId} did not signal completion.`);
                    return;
                }

                emitLog(
                    `McpImageClusteringAgent complete for Task ${params.TaskId}: ${status.summary}`,
                    'tool_result',
                    'McpImageClusteringAgent'
                );
                resolve(`MCP image clustering complete for Task ${params.TaskId}. ${status.summary}`);

            } catch (e: any) {
                emitLog(`McpImageClusteringAgent error: ${e.message}`, 'error', 'McpImageClusteringAgent');
                resolve(`Error: MCP image clustering sub-agent failed — ${e.message}`);
            }
        });
    }
};
