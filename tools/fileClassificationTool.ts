import { LLMService } from "../src/LLMService.js";
import { EmbeddingService } from "../src/EmbeddingService.js";
import { ClassificationUtility } from "../src/utils/classificationUtility.js";
import { FileContentExtractor } from "../src/utils/fileContentExtractor.js";
import * as path from 'path';
import { OpenAISession, workerAgent } from "../src/workerAgent.js";
import { LlamaJsonSchemaGrammar } from "node-llama-cpp";
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
     * Given a list of unclassified files, categorizes them using content and provides folder suggestions.
     */
    public static async clusterAndNameFiles(filePaths: string[], progress: ClusteringProgressContext): Promise<Record<string, string[]>> {
        if (filePaths.length === 0) {
            return {};
        }

        const llmService = await LLMService.getInstance();
        const embeddingService = await EmbeddingService.getInstance();
        emitAgentMessage(`Analyzing ${filePaths.length} files...`, 'task_update', progress.groupId);
        emitLog(`Extracting content & embedding ${filePaths.length} files for ${progress.label}`, 'pipeline', 'Clustering');

        try {
            // 1. Extract content and Generate Embeddings
            const embeddings: number[][] = [];
            const contents: string[] = [];
            for (const [i, filePath] of filePaths.entries()) {
                const { baseName, snippet } = await FileContentExtractor.extractContent(filePath);
                // Filename is kept separately for the naming prompt, but excluded from the
                // embedding input so arbitrary/repeated filename tokens don't skew clustering.
                contents.push(`Title: ${baseName}\n\nSnippet: ${snippet}`);
                const embeddingInput = snippet.trim().length > 0 ? snippet : baseName;
                const embedding = await embeddingService.generateEmbedding(embeddingInput, "search_document: ");
                embeddings.push(embedding);
                emitLog(`Embedded ${i + 1}/${filePaths.length}: ${baseName}`, 'tool_result', 'Clustering');
            }

            // 2. Cluster the files using Python bridge
            emitLog('Clustering embeddings...', 'pipeline', 'Clustering');
            const clusterResult = await ClassificationUtility.clusterEmbeddings(embeddings);
            const labels = clusterResult.labels;
            const representatives = clusterResult.representatives;
            
            // Group filenames by cluster label
            const clusters: Record<number, string[]> = {};
            for (let i = 0; i < labels.length; i++) {
                const label = labels[i];
                if (!clusters[label]) {
                    clusters[label] = [];
                }
                clusters[label].push(path.basename(filePaths[i]));
            }
            
            // 3. Generate Folder Names using LLM for each valid cluster
            const result: Record<string, string[]> = {};
            const clusterCount = Object.keys(clusters).length;
            emitAgentMessage(`Naming ${clusterCount} group(s) for ${progress.label}...`, 'task_update', progress.groupId);
            emitLog(`Generating folder names for ${clusterCount} cluster(s)`, 'pipeline', 'Clustering');

            const sysprompt = fileCategorizationPrompt;
            
            
            for (const [labelStr, fileNames] of Object.entries(clusters)) {
                const label = parseInt(labelStr, 10);
                
                if (label === -1) {
                    // Noise / Unclassified files
                    result['Uncategorized'] = (result['Uncategorized'] || []).concat(fileNames);
                }
                else {
                    // Get snippets of representative files
                    const repIndices = representatives[label.toString()] || [];
                    const repContents = repIndices.map(idx => contents[idx]);
                    const contentToLLM = repContents.length > 0 ? repContents.join('\n\n') : fileNames.join('\n');
                    
                    // Ask LLM to name the folder based on the file contents
                    const prompt = `Files to categorize:
                            ${contentToLLM}

                            Folder name:`;

                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            { role: "system", content: sysprompt + "\n\nRespond ONLY with a valid JSON object containing a 'category_name' string property." },
                            { role: "user", content: prompt }
                        ],
                        temperature: 0.0,
                        response_format: {
                            type: "json_schema",
                            json_schema: {
                                name: "category",
                                strict: true,
                                schema: {
                                    type: "object",
                                    properties: {
                                        category_name: { type: "string" }
                                    },
                                    required: ["category_name"],
                                    additionalProperties: false
                                }
                            }
                        }
                    });

                    let rawOutput = response.choices[0]?.message?.content || "";
                    let folderName = `Category_${label}`;
                    
                    try {
                        const parsed = JSON.parse(rawOutput);
                        if (parsed.category_name) {
                            folderName = parsed.category_name;
                        }
                    } catch (e) {
                        // Fallback if model somehow bypassed JSON schema
                        folderName = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || folderName;
                    }
                    
                    // Cleanup LLM output to grab just the first line/clean name
                    let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();

                    if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                        cleanFolderName = `Category_${label}`;
                    }

                    emitLog(`Cluster ${label} (${fileNames.length} files) → "${cleanFolderName}"`, 'tool_result', 'Clustering');

                    result[cleanFolderName] = (result[cleanFolderName] || []).concat(fileNames);

                }
            }
            // 3.5 Deduplicate similar folder names
            const folderNames = Object.keys(result);
            if (folderNames.length > 1) {
                emitLog('Checking for similar category names to deduplicate...', 'pipeline', 'Clustering');

                const merges = await ClassificationUtility.deduplicateCategories(folderNames, llmService);

                if (merges.length > 0) {
                    emitLog(`Merged ${merges.length} similar categories`, 'tool_result', 'Clustering');
                    for (const merge of merges) {
                        if (result[merge.source] && result[merge.target] && merge.source !== merge.target) {
                            result[merge.target] = result[merge.target].concat(result[merge.source]);
                            delete result[merge.source];
                        } else if (result[merge.source] && !result[merge.target]) {
                            // Rename case where target doesn't exist
                            result[merge.target] = result[merge.source];
                            delete result[merge.source];
                        }
                    }
                }
            }

            emitAgentMessage(`${progress.label}: organized into ${Object.keys(result).length} categories`, 'task_update', progress.groupId);
            return result;

        } catch (err: any) {
            console.error("Error during file classification:", err);
            emitLog(`Error during classification: ${err?.message ?? err}`, 'error', 'Clustering');
            throw err;
        } finally {
            // 4. Dispose embedding model to free memory
            if (embeddingService) {
                embeddingService.dispose();
            }
        }
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

        return output;
    }
}
