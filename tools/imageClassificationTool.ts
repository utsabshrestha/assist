import { LLMService } from "../src/LLMService.js";
import { EmbeddingService } from "../src/EmbeddingService.js";
import { ClassificationUtility, extractTaggedOutput, repairTaggedOutput } from "../src/utils/classificationUtility.js";
import { getLowResBase64Image } from "../src/utils/imageUtility.js";
import { fileCategorizationPrompt, imageDescriptionPrompt } from "../src/prompt/fileAgent.js";
import * as path from 'path';
import { emitLog, emitAgentMessage } from "../electron/ipcBridge.js";
import type { ClusteringProgressContext } from "./fileClassificationTool.js";

export class ImageClassificationTool {

    /**
     * Given a list of image file paths, describes each image via the LLM vision API,
     * embeds the descriptions, clusters them, and assigns category names.
     * Returns a map of category name → list of filenames.
     */
    public static async clusterAndNameImages(filePaths: string[], progress: ClusteringProgressContext): Promise<Record<string, string[]>> {
        if (filePaths.length === 0) {
            return {};
        }

        const llmService = await LLMService.getInstance();
        const embeddingService = await EmbeddingService.getInstance();

        try {
            // ── Step 1: Describe each image via LLM vision (sequential to avoid RAM overload) ──
            emitAgentMessage(`Describing ${filePaths.length} images...`, 'task_update', progress.groupId);
            emitLog(`Describing ${filePaths.length} images sequentially`, 'pipeline', 'Clustering');
            const descriptions: string[] = [];

            for (const [i, filePath] of filePaths.entries()) {
                const fileName = path.basename(filePath);

                try {
                    // Resize to 256px max dimension for speed/VRAM savings
                    const base64 = await getLowResBase64Image(filePath, 256);

                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            { role: "system", content: imageDescriptionPrompt + "\n\nRespond ONLY with a valid JSON object containing a 'description' string property." },
                            {
                                role: "user",
                                content: [
                                    {
                                        type: "image_url",
                                        image_url: {
                                            url: `data:image/jpeg;base64,${base64}`,
                                        }
                                    },
                                    {
                                        type: "text",
                                        text: `Describe this image. File name: ${fileName}`
                                    }
                                ]
                            }
                        ],
                        temperature: 0.1,
                        response_format: {
                            type: "json_schema",
                            json_schema: {
                                name: "image_description",
                                strict: true,
                                schema: {
                                    type: "object",
                                    properties: {
                                        description: { type: "string" }
                                    },
                                    required: ["description"],
                                    additionalProperties: false
                                }
                            }
                        }
                    });

                    let rawOutput = response.choices[0]?.message?.content || "";
                    let description = fileName; // Fallback to filename

                    try {
                        const parsed = JSON.parse(rawOutput);
                        if (parsed.description && parsed.description.trim().length > 0) {
                            description = parsed.description.trim();
                        }
                    } catch {
                        // Strip any <think> tags from reasoning models and use as-is
                        description = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || fileName;
                    }

                    descriptions.push(description);
                    emitLog(`Described ${i + 1}/${filePaths.length}: ${fileName} → "${description.substring(0, 80)}..."`, 'tool_result', 'Clustering');
                } catch (err: any) {
                    console.error(`\x1b[91m[Vision Error]\x1b[0m Failed to describe ${fileName}: ${err.message}`);
                    emitLog(`Failed to describe ${fileName}: ${err.message}`, 'error', 'Clustering');
                    // Use filename as fallback description so embedding still works
                    descriptions.push(fileName);
                }
            }

            // ── Step 2: Embed all descriptions ──
            emitLog(`Generating embeddings for ${descriptions.length} image descriptions`, 'pipeline', 'Clustering');
            const embeddings: number[][] = [];

            for (const description of descriptions) {
                const embedding = await embeddingService.generateEmbedding(description, "search_document: ");
                embeddings.push(embedding);
            }

            // ── Step 3: Cluster using Python HDBSCAN bridge ──
            emitLog('Clustering image description embeddings...', 'pipeline', 'Clustering');
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

            // ── Step 4: Name each cluster via LLM ──
            const result: Record<string, string[]> = {};
            const clusterCount = Object.keys(clusters).length;
            emitAgentMessage(`Naming ${clusterCount} group(s) for ${progress.label}...`, 'task_update', progress.groupId);
            emitLog(`Generating category names for ${clusterCount} image cluster(s)`, 'pipeline', 'Clustering');

            const sysprompt = fileCategorizationPrompt;

            for (const [labelStr, fileNames] of Object.entries(clusters)) {
                const label = parseInt(labelStr, 10);

                if (label === -1) {
                    // Noise / Unclassified images
                    result['Uncategorized'] = (result['Uncategorized'] || []).concat(fileNames);
                } else {
                    // Get descriptions of representative files for this cluster, tagged by
                    // distance-to-centroid position — see fileClassificationTool.ts.
                    const repIndices = representatives[label.toString()] || [];
                    const repDescriptions = repIndices.map((idx, i) => {
                        const positionTag = ClassificationUtility.describeRepresentativePosition(i, repIndices.length);
                        return `[${positionTag}]\n${descriptions[idx]}`;
                    });
                    const contentToLLM = repDescriptions.length > 0
                        ? repDescriptions.join('\n\n')
                        : fileNames.join('\n');

                    // See fileClassificationTool.ts — representatives are a sample of a
                    // potentially larger cluster; list full membership so the model can
                    // broaden the name instead of naming only what it was shown.
                    const allFilesNote = fileNames.length > repIndices.length
                        ? `\n\nAll ${fileNames.length} files in this group: ${fileNames.join(', ')}`
                        : '';

                    // See fileClassificationTool.ts — surfaces cluster density as evidence
                    // for the prompt's "do any files break the theme" check.
                    const outlierCount = outlierCounts[label.toString()] || 0;
                    const outlierNote = outlierCount > 0
                        ? `\n\nNote: ${outlierCount} of ${fileNames.length} images in this group sit notably farther from the group's center than the rest — they may be off-theme.`
                        : '';

                    const prompt = `These are descriptions of images that belong to the same visual group:\n${contentToLLM}${allFilesNote}${outlierNote}\n\nFolder name:`;

                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            { role: "system", content: sysprompt },
                            { role: "user", content: prompt }
                        ],
                        temperature: 0.2,
                        // See fileClassificationTool.ts for both of these: cache_prompt avoids
                        // cross-session KV cache slot reuse; max_tokens gives the model real
                        // room to finish reasoning over denser clusters before answering.
                        // @ts-ignore - llama.cpp passthrough extra, not in the OpenAI SDK types
                        cache_prompt: false,
                        max_tokens: 1800,
                        // See fileClassificationTool.ts: 1.1 instead of 1.3, since the higher
                        // value fought the reasoning trace's natural repetition and made the
                        // model less likely to close the <output> tag consistently.
                        // @ts-ignore - llama.cpp's OpenAI-compatible server accepts repeat_penalty as a passthrough extra
                        repeat_penalty: 1.1,
                        // No JSON schema enforced — see fileClassificationTool.ts: forcing JSON
                        // commits the model to an answer token-by-token with no room to reason
                        // first. The prompt has it reason freely, then emit the folder name
                        // inside <output>...</output>.
                    });

                    const message: any = response.choices[0]?.message;
                    // Raw request/response, kept on a separate 'tool_call'-typed log so it's
                    // filterable independently from the human-readable summary below — for
                    // debugging the prompt/model, not for end-user visibility.
                    emitLog(`Image cluster ${label} prompt:\n${prompt}\n\nRaw model output:\n${JSON.stringify(message, null, 2)}`, 'tool_call', 'Clustering');

                    let folderName = extractTaggedOutput(message);
                    if (!folderName) {
                        // See fileClassificationTool.ts — finish_reason distinguishes a
                        // max_tokens cutoff from a forgotten closing tag, before trying the
                        // repair call.
                        const finishReason = response.choices[0]?.finish_reason;
                        const rawText = message?.content || message?.reasoning_content || "";
                        emitLog(`Image cluster ${label}: no <output> tag found (finish_reason=${finishReason}, ${rawText.length} chars), attempting repair`, 'tool_result', 'Clustering');
                        folderName = await repairTaggedOutput(rawText, llmService) || `Image_Category_${label}`;
                    }

                    // Clean the name
                    let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();

                    if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                        cleanFolderName = `Image_Category_${label}`;
                    }

                    // Human-readable summary: which images drove the name and why, so a user
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
                        `Image cluster ${label} (${fileNames.length} files) → "${cleanFolderName}"\n` +
                        `Based on: ${basedOnFiles}\n` +
                        `Reasoning: ${reasoningPreview || '(none — name was repaired from incomplete output)'}`,
                        'tool_result',
                        'Clustering'
                    );

                    result[cleanFolderName] = (result[cleanFolderName] || []).concat(fileNames);
                }
            }

            // ── Step 5: Deduplicate similar category names ──
            const folderNames = Object.keys(result);
            if (folderNames.length > 1) {
                emitLog('Checking for similar image category names to deduplicate...', 'pipeline', 'Clustering');

                const merges = await ClassificationUtility.deduplicateCategories(folderNames, llmService);

                if (merges.length > 0) {
                    emitLog(`Merged ${merges.length} similar image categories`, 'tool_result', 'Clustering');
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

            emitAgentMessage(`${progress.label}: organized into ${Object.keys(result).length} categories`, 'task_update', progress.groupId);
            return result;

        } catch (err: any) {
            console.error("Error during image classification:", err);
            emitLog(`Error during classification: ${err?.message ?? err}`, 'error', 'Clustering');
            throw err;
        } finally {
            if (embeddingService) {
                embeddingService.dispose();
            }
        }
    }
}
