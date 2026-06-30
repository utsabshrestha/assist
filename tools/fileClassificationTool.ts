import { LLMService } from "../src/LLMService.js";
import { EmbeddingService } from "../src/EmbeddingService.js";
import { ClassificationUtility, extractTaggedOutput, repairTaggedOutput } from "../src/utils/classificationUtility.js";
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
            const outlierCounts = clusterResult.outlierCounts;
            
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
                    // Get snippets of representative files, tagged by distance-to-centroid
                    // position (Core = most typical, Edge = most atypical) so the model can
                    // weigh a lone Edge sample differently than a Core one instead of treating
                    // all samples as equally representative of the cluster.
                    const repIndices = representatives[label.toString()] || [];
                    const repContents = repIndices.map((idx, i) => {
                        const positionTag = ClassificationUtility.describeRepresentativePosition(i, repIndices.length);
                        return `[${positionTag}]\n${contents[idx]}`;
                    });
                    const contentToLLM = repContents.length > 0 ? repContents.join('\n\n') : fileNames.join('\n');

                    const allFilesNote = fileNames.length > repIndices.length
                        ? `\n\nAll ${fileNames.length} files in this group: ${fileNames.join(', ')}`
                        : '';

                    // Surface cluster density so the model has actual evidence for "do any
                    // files break the theme" instead of guessing from a handful of samples —
                    // most useful on large clusters where only ~8 of many files were shown.
                    const outlierCount = outlierCounts[label.toString()] || 0;
                    const outlierNote = outlierCount > 0
                        ? `\n\nNote: ${outlierCount} of ${fileNames.length} files in this group sit notably farther from the group's center than the rest — they may be off-theme.`
                        : '';

                    // Ask LLM to name the folder based on the file contents
                    const prompt = `Files to categorize:
                            ${contentToLLM}${allFilesNote}${outlierNote}

                            Folder name:`;

                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            { role: "system", content: sysprompt },
                            { role: "user", content: prompt }
                        ],
                        temperature: 0.2,
                        // @ts-ignore - llama.cpp passthrough extra, not in the OpenAI SDK types
                        cache_prompt: false,
                        max_tokens: 1800,
                        // 1.3 fought the reasoning trace's natural repetition (e.g. "this file is
                        // about...") and made the model less likely to close the <output> tag
                        // consistently. 1.1 still discourages loops without that side effect.
                        // @ts-ignore - llama.cpp's OpenAI-compatible server accepts repeat_penalty as a passthrough extra
                        repeat_penalty: 1.1,
                    });

                    const message: any = response.choices[0]?.message;
                    // Raw request/response, kept on a separate 'tool_call'-typed log so it's
                    // filterable independently from the human-readable summary below — for
                    // debugging the prompt/model, not for end-user visibility.
                    emitLog(`Cluster ${label} prompt:\n${prompt}\n\nRaw model output:\n${JSON.stringify(message, null, 2)}`, 'tool_call', 'Clustering');

                    let folderName = extractTaggedOutput(message);
                    if (!folderName) {
                        // Distinguish "hit max_tokens mid-reasoning" (still rambling, needs a
                        // bigger budget) from "stopped naturally but forgot the tag" (a
                        // formatting slip the repair call below can usually fix) — same failure
                        // symptom downstream, different root cause to tune against.
                        const finishReason = response.choices[0]?.finish_reason;
                        const rawText = message?.content || message?.reasoning_content || "";
                        emitLog(`Cluster ${label}: no <output> tag found (finish_reason=${finishReason}, ${rawText.length} chars), attempting repair`, 'tool_result', 'Clustering');
                        folderName = await repairTaggedOutput(rawText, llmService) || `Category_${label}`;
                    }

                    // Cleanup LLM output to grab just the first line/clean name
                    let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();

                    if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                        cleanFolderName = `Category_${label}`;
                    }

                    // Human-readable summary: which files drove the name and why, so a user
                    // can relate the result back to their own files, and a technical viewer
                    // can see the model's actual reasoning (not just the final name).
                    const reasoningPreview = (message?.content || message?.reasoning_content || "")
                        .replace(/<output>[\s\S]*?<\/output>/i, '')
                        .trim();
                    const basedOnFiles = repIndices
                        .map(idx => filePaths[idx])
                        .filter((p): p is string => p !== undefined)
                        .map(p => path.basename(p))
                        .join(', ');
                    emitLog(
                        `Cluster ${label} (${fileNames.length} files) → "${cleanFolderName}"\n` +
                        `Based on: ${basedOnFiles}\n` +
                        `Reasoning: ${reasoningPreview || '(none — name was repaired from incomplete output)'}`,
                        'tool_result',
                        'Clustering'
                    );

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
