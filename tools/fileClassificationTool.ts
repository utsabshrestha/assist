import { LLMService } from "../src/LLMService.js";
import { ClassificationUtility, extractTaggedOutput, repairTaggedOutput } from "../src/utils/classificationUtility.js";
import { McpClientService } from "../src/services/McpClientService.js";
import * as path from 'path';
import { fileCategorizationPrompt, nonDocumentCategorizationPrompt } from "../src/prompt/fileAgent.js";
import { lookupExtensionCategory } from "../src/utils/extensionCategoryMap.js";
import { emitLog, emitAgentMessage } from "../electron/ipcBridge.js";

export interface ClusteringProgressContext {
    processId: string;
    groupId: string;
    label: string;
}

export class FileClassificationTool {

    /**
     * Given a list of unclassified files, categorizes them by calling the local MCP server
     * (evaluate_clustering then get_clustering_result) and passing extracted keywords to the
     * LLM to generate descriptive folder names.
     *
     * @deprecated Prefer using McpClusteringAgent (sub-agent) for document workflows.
     *             This method remains for non-agent callers (e.g. image classification).
     */
    public static async clusterAndNameFiles(filePaths: string[], progress: ClusteringProgressContext): Promise<Record<string, string[]>> {
        if (filePaths.length === 0) {
            return {};
        }

        emitAgentMessage(`Analyzing ${filePaths.length} files with MCP...`, 'task_update', progress.groupId);
        emitLog(`Invoking MCP semantic clustering for ${filePaths.length} file(s) (${progress.label})`, 'pipeline', 'Clustering');

        try {
            const folderPath = path.dirname(filePaths[0] ?? '');
            const extensions = Array.from(new Set(filePaths.map(p => path.extname(p).toLowerCase())));

            const mcpService = McpClientService.getInstance();

            // Step 1: evaluate_clustering (compact metrics + run_id, no file list)
            const evaluation = await mcpService.evaluateClustering(folderPath, extensions);

            if (!evaluation?.run_id) {
                throw new Error('evaluate_clustering did not return a run_id.');
            }

            emitLog(
                `evaluate_clustering: rating=${evaluation.rating}, score=${evaluation.score}, run_id=${evaluation.run_id}`,
                'tool_result', 'Clustering'
            );

            // Step 2: retrieve the full result and name the topics
            const fullResult = await mcpService.getClusteringResult(evaluation.run_id);
            return await FileClassificationTool.nameTopicsFromMcpResponse(fullResult, progress);

        } catch (error) {
            emitLog(`Error in clusterAndNameFiles: ${error instanceof Error ? error.message : String(error)}`, 'error', 'Clustering');
            throw error;
        }
    }

    /**
     * Takes raw MCP cluster results (topics, c-TF-IDF keywords, files), runs an LLM naming pass for each topic,
     * deduplicates category names, and returns a Record<categoryName, fileName[]>.
     */
    public static async nameTopicsFromMcpResponse(mcpResponse: any, progress: ClusteringProgressContext): Promise<Record<string, string[]>> {
        const llmService = await LLMService.getInstance();
        const topics = mcpResponse.topics || [];
        const result: Record<string, string[]> = {};

        emitAgentMessage(`Naming ${topics.length} topic group(s) for ${progress.label}...`, 'task_update', progress.groupId);
        emitLog(`Generating folder names for ${topics.length} MCP topic cluster(s)`, 'info', 'Topic Name Suggestion Agent');

        const sysprompt = fileCategorizationPrompt;

        // Process each topic cluster returned by MCP
        for (let i = 0; i < topics.length; i++) {
            const topic = topics[i];
            const fileNames = (topic.files || []).map((f: any) => f.name || path.basename(f.absolute_path));
            const keywordList = (topic.keywords || []).map((k: any) => k.term);
            const keywordsText = keywordList.length > 0
                ? keywordList.join(', ')
                : '(no distinctive keywords extracted)';

            if (topic.topic_id === -1) {
                result['Uncategorized'] = (result['Uncategorized'] || []).concat(fileNames);
                continue;
            }

            const repFiles = (topic.files || []).slice(0, 4);
            const repFileLines = repFiles.map((f: any, idx: number) => {
                const positionTag = ClassificationUtility.describeRepresentativePosition(idx, repFiles.length);
                return `[${positionTag}] ${f.name || path.basename(f.absolute_path)}`;
            }).join('\n');

            const allFilesNote = fileNames.length > repFiles.length
                ? `\n\nAll ${fileNames.length} files in this group: ${fileNames.join(', ')}`
                : '';

            const prompt = `Files to categorize:
                    Distinctive keywords: ${keywordsText}

                    Representative files:
                    ${repFileLines}${allFilesNote}

                    Folder name:`;

            const response = await llmService.openai.chat.completions.create({
                model: llmService.modelName,
                messages: [
                    { role: "system", content: sysprompt },
                    { role: "user", content: prompt }
                ],
                temperature: 0.2,
                // @ts-ignore - llama.cpp passthrough extra
                cache_prompt: false,
                max_tokens: 1800,
                // @ts-ignore - llama.cpp passthrough extra
                repeat_penalty: 1.1,
            });

            const message: any = response.choices[0]?.message;


            let folderName = extractTaggedOutput(message);
            if (!folderName) {
                const rawText = message?.content || message?.reasoning_content || "";
                emitLog(JSON.stringify({
                    topicId: topic.id,
                    rawText: rawText,
                    error: "no <output> tag found, attempting repair"
                }), 'error', 'Topic Name Suggestion Agent');
                folderName = await repairTaggedOutput(rawText, llmService) || `Category_${topic.topic_id}`;
            }

            let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();

            if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                cleanFolderName = `Category_${topic.topic_id}`;
            }

            const reasoningPreview = (message?.content || message?.reasoning_content || "")
                .replace(/<output>[\s\S]*?<\/output>/i, '')
                .trim();

            emitLog(JSON.stringify({
                topicId: topic.id,
                keyWords: keywordList,
                files: fileNames,
                SuggestedFolderName: folderName,
            }), 'info', 'Topic Name Suggestion Agent');

            result[cleanFolderName] = (result[cleanFolderName] || []).concat(fileNames);
        }

        // Handle any outliers reported separately by MCP
        if (mcpResponse.outliers && mcpResponse.outliers.length > 0) {
            const outlierNames = mcpResponse.outliers.map((f: any) => typeof f === 'string' ? path.basename(f) : f.name || path.basename(f.absolute_path));
            result['Uncategorized'] = (result['Uncategorized'] || []).concat(outlierNames);
        }

        // Deduplicate similar folder names
        const folderNames = Object.keys(result);
        if (folderNames.length > 1) {
            emitLog('Checking for similar category names to deduplicate...', 'info', 'Topic Name Deduplication Agent');

            const merges = await ClassificationUtility.deduplicateCategories(folderNames, llmService);

            if (merges.length > 0) {
                emitLog(`Merged ${merges.length} similar categories`, 'info', 'Topic Name Deduplication Agent');
                for (const merge of merges) {
                    if (result[merge.source] && result[merge.target] && merge.source !== merge.target) {
                        result[merge.target] = result[merge.target].concat(result[merge.source]);
                        delete result[merge.source];
                    } else if (result[merge.source] && !result[merge.target]) {
                        result[merge.target] = result[merge.source];
                        delete result[merge.source];
                    }
                }
            }
        }

        return result;
    }

    public static async GetNonDocumentExtensionCategorized(extensions: string[]): Promise<Record<string, string[]>> {
        const output: Record<string, string[]> = {};
        const unmatched: string[] = [];

        // Deterministic lookup first — extension→category for common cases is unambiguous
        // and doesn't need a model call.
        for (const ext of extensions) {
            const category = lookupExtensionCategory(ext);
            if (category) {
                (output[category] ||= []).push(ext);
            } else {
                unmatched.push(ext);
            }
        }

        if (unmatched.length === 0) {
            return output;
        }

        const llmService = await LLMService.getInstance();

        const response = await llmService.openai.chat.completions.create({
            model: llmService.modelName,
            messages: [
                {
                    role: "system",
                    content: nonDocumentCategorizationPrompt(unmatched) + "\n\nRespond ONLY with a valid JSON matching the requested schema."
                },
                {
                    role: "user",
                    content: "Start categorizing these extensions."
                }
            ],
            temperature: 0.1,
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "category_structure",
                    strict: true,
                    schema: {
                        type: "object", // Root must be an object
                        properties: {
                            categories: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        category: { type: "string", description: "Category name." },
                                        extensions: {
                                            type: "array",
                                            items: {
                                                type: "string",
                                                description: "Extension that falls into this category. Example: '.mp4'"
                                            },
                                            description: "List of extensions that fall into this category." // Fixed typo
                                        }
                                    },
                                    required: ["category", "extensions"], // Fixed missing required properties
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ["categories"],
                        additionalProperties: false
                    }
                }
            }
        });

        let rawOutput = response.choices[0]?.message?.content || "";

        // Strip any <think> tags if a reasoning model (like deepseek-reasoner) was used
        rawOutput = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        try {
            const parsed = JSON.parse(rawOutput);

            // Map the schema array into the desired Record<string, string[]> format
            if (parsed && Array.isArray(parsed.categories)) {
                for (const item of parsed.categories) {
                    if (item.category && Array.isArray(item.extensions)) {
                        output[item.category] = (output[item.category] || []).concat(item.extensions);
                    }
                }
            }
        } catch (error) {
            console.error("Failed to parse LLM response JSON:", error);
            // Handle fallback or rethrow depending on your application needs
        }

        emitLog(JSON.stringify({
            inputExtensions: extensions,
            output: output,
        }), 'info', 'Non Document Extension Categorization Agent');

        return output;
    }
}
