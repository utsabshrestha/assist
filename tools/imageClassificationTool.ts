import { LLMService } from "../src/LLMService.js";
import { EmbeddingService } from "../src/EmbeddingService.js";
import { ClassificationUtility } from "../src/utils/classificationUtility.js";
import { getLowResBase64Image } from "../src/utils/imageUtility.js";
import { fileCategorizationPrompt, dedupCategoryPrompt, imageDescriptionPrompt } from "../src/prompt/fileAgent.js";
import * as path from 'path';

export class ImageClassificationTool {

    /**
     * Given a list of image file paths, describes each image via the LLM vision API,
     * embeds the descriptions, clusters them, and assigns category names.
     * Returns a map of category name → list of filenames.
     */
    public static async clusterAndNameImages(filePaths: string[]): Promise<Record<string, string[]>> {
        if (filePaths.length === 0) {
            return {};
        }

        const llmService = await LLMService.getInstance();
        const embeddingService = await EmbeddingService.getInstance();

        try {
            // ── Step 1: Describe each image via LLM vision (sequential to avoid RAM overload) ──
            console.log(`\x1b[36m[Vision]\x1b[0m Describing ${filePaths.length} images sequentially...`);
            const descriptions: string[] = [];

            for (let i = 0; i < filePaths.length; i++) {
                const filePath = filePaths[i];
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
                    console.log(`\x1b[36m[Vision]\x1b[0m Described image ${i + 1}/${filePaths.length}: ${fileName} → "${description.substring(0, 80)}..."`);
                } catch (err: any) {
                    console.error(`\x1b[91m[Vision Error]\x1b[0m Failed to describe ${fileName}: ${err.message}`);
                    // Use filename as fallback description so embedding still works
                    descriptions.push(fileName);
                }
            }

            // ── Step 2: Embed all descriptions ──
            console.log(`\x1b[36m[Embedding]\x1b[0m Generating embeddings for ${descriptions.length} image descriptions...`);
            const embeddings: number[][] = [];

            for (const description of descriptions) {
                const embedding = await embeddingService.generateEmbedding(description, "search_document: ");
                embeddings.push(embedding);
            }

            // ── Step 3: Cluster using Python HDBSCAN bridge ──
            console.log("\x1b[36m[Clustering]\x1b[0m Clustering image description embeddings...");
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

            // ── Step 4: Name each cluster via LLM ──
            const result: Record<string, string[]> = {};
            console.log("\x1b[36m[Naming]\x1b[0m Generating category names from image clusters...");

            const sysprompt = fileCategorizationPrompt;

            for (const [labelStr, fileNames] of Object.entries(clusters)) {
                const label = parseInt(labelStr, 10);

                if (label === -1) {
                    // Noise / Unclassified images
                    result['Uncategorized'] = (result['Uncategorized'] || []).concat(fileNames);
                } else {
                    // Get descriptions of representative files for this cluster
                    const repIndices = representatives[label.toString()] || [];
                    const repDescriptions = repIndices.map(idx => descriptions[idx]);
                    const contentToLLM = repDescriptions.length > 0
                        ? repDescriptions.join('\n\n')
                        : fileNames.join('\n');

                    const prompt = `These are descriptions of images that belong to the same visual group:\n${contentToLLM}\n\nFolder name:`;

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
                    let folderName = `Image_Category_${label}`;

                    try {
                        const parsed = JSON.parse(rawOutput);
                        if (parsed.category_name) {
                            folderName = parsed.category_name;
                        }
                    } catch {
                        folderName = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || folderName;
                    }

                    console.log(`\x1b[36m[LLM Naming]\x1b[0m Image cluster ${label} (${fileNames.length} files) → "${folderName}"`);

                    // Clean the name
                    let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();

                    if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                        cleanFolderName = `Image_Category_${label}`;
                    }

                    result[cleanFolderName] = (result[cleanFolderName] || []).concat(fileNames);
                }
            }

            // ── Step 5: Deduplicate similar category names ──
            const folderNames = Object.keys(result);
            if (folderNames.length > 1) {
                console.log("\x1b[36m[Dedup]\x1b[0m Checking for similar image category names to deduplicate...");

                const userDedupPrompt =
                    `Review and deduplicate this folder list. Output only the JSON merges object.\n\nFolders:\n${JSON.stringify(folderNames, null, 2)}\n\nJSON:`;

                try {
                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            { role: "system", content: dedupCategoryPrompt },
                            { role: "user", content: userDedupPrompt }
                        ],
                    });

                    const dedupeResult = response.choices[0]?.message?.content || "";
                    const merges = parseDedupeOutput(dedupeResult).merges;

                    if (merges && merges.length > 0) {
                        console.log(`\x1b[92m[Dedup]\x1b[0m Found ${merges.length} similar image categories to merge.`);
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
                } catch (e) {
                    console.error("Error during image category de-duplication:", e);
                }
            }

            return result;

        } catch (err) {
            console.error("Error during image classification:", err);
            throw err;
        } finally {
            if (embeddingService) {
                embeddingService.dispose();
            }
        }
    }
}

function parseDedupeOutput(raw: string): { merges: { source: string, target: string }[] } {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { merges: [] };

    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed.merges)) return { merges: [] };
        return {
            merges: parsed.merges.filter(
                (m: any) => typeof m.source === 'string' && typeof m.target === 'string'
            )
        };
    } catch {
        return { merges: [] };
    }
}
