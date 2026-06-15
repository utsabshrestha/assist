import { LLMService } from "../src/LLMService.js";
import { EmbeddingService } from "../src/EmbeddingService.js";
import { ClassificationUtility } from "../src/utils/classificationUtility.js";
import { FileContentExtractor } from "../src/utils/fileContentExtractor.js";
import * as path from 'path';
import { OpenAISession, workerAgent } from "../src/workerAgent.js";
import { LlamaJsonSchemaGrammar } from "node-llama-cpp";
import { dedupCategoryPrompt, fileCategorizationPrompt, nonDocumentCategorizationPrompt } from "../src/prompt/fileAgent.js";

export class FileClassificationTool {
    
    /**
     * Given a list of unclassified files, categorizes them using content and provides folder suggestions.
     */
    public static async clusterAndNameFiles(filePaths: string[]): Promise<Record<string, string[]>> {
        if (filePaths.length === 0) {
            return {};
        }

        const llmService = await LLMService.getInstance();
        const embeddingService = await EmbeddingService.getInstance();
        console.log(`Generating embeddings for ${filePaths.length} files...`);
        
        try {
            // 1. Extract content and Generate Embeddings
            const embeddings: number[][] = [];
            const contents: string[] = [];
            for (const filePath of filePaths) {
                const content = await FileContentExtractor.extractContent(filePath);
                contents.push(content);
                const embedding = await embeddingService.generateEmbedding(content, "search_document: ");
                embeddings.push(embedding);
            }
            
            // 2. Cluster the files using Python bridge
            console.log("Clustering embeddings using Python bridge...");
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
            console.log("Generating folder names from clusters...");
            
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

                    console.log(sysprompt);
                    console.log(prompt);

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
                    
                    console.log(`\x1b[36m[LLM Naming]\x1b[0m Cluster ${label} files (${fileNames.length}) -> LLM returned: "${folderName}"`);
                    
                    // Cleanup LLM output to grab just the first line/clean name
                    let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();
                    
                    if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                        cleanFolderName = `Category_${label}`;
                    }

                    result[cleanFolderName] = (result[cleanFolderName] || []).concat(fileNames);
                    
                }
            }
            // 3.5 Deduplicate similar folder names
            const folderNames = Object.keys(result);
            if (folderNames.length > 1) {
                console.log("Checking for similar category names to deduplicate...");
                

                const dedupePrompt = dedupCategoryPrompt;

                const userDedupPrompt = 
                `Review and deduplicate this folder list. Output only the JSON merges object.

                Folders:
                ${JSON.stringify(folderNames, null, 2)}

                JSON:`;


                try {
                    const response = await llmService.openai.chat.completions.create({
                        model: llmService.modelName,
                        messages: [
                            { role: "system", content: dedupePrompt },
                            { role: "user", content: userDedupPrompt }
                        ],
                    });

                    const dedupeResult = response.choices[0]?.message?.content || "";

                    let merges = parseDedupeOutput(dedupeResult).merges;

                    if (merges && merges.length > 0) {
                        console.log(`\x1b[92m[Worker]\x1b[0m Found ${merges.length} similar categories to merge.`);
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
                } catch (e) {
                    console.error("Error during category de-duplication:", e);
                }
            }

            return result;

        } catch (err) {
            console.error("Error during file classification:", err);
            throw err;
        } finally {
            // 4. Dispose embedding model to free memory
            if (embeddingService) {
                embeddingService.dispose();
            }
        }
    }

    public static async GetNonDocumentExtensionCategorized(extensions: string[]): Promise<Record<string, string[]>> {
        const llmService = await LLMService.getInstance();
        
        const response = await llmService.openai.chat.completions.create({
            model: llmService.modelName,
            messages: [
                { 
                    role: "system", 
                    content: nonDocumentCategorizationPrompt(extensions) + "\n\nRespond ONLY with a valid JSON matching the requested schema." 
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

        const output: Record<string, string[]> = {};
        let rawOutput = response.choices[0]?.message?.content || "";

        // Strip any <think> tags if a reasoning model (like deepseek-reasoner) was used
        rawOutput = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        try {
            const parsed = JSON.parse(rawOutput);
            
            // Map the schema array into the desired Record<string, string[]> format
            if (parsed && Array.isArray(parsed.categories)) {
                for (const item of parsed.categories) {
                    if (item.category && Array.isArray(item.extensions)) {
                        output[item.category] = item.extensions;
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
function parseDedupeOutput(raw: string): { merges: {source: string, target: string}[] } {
  // Extract first JSON object found, even if model adds trailing text
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { merges: [] };
  
  try {
    const parsed = JSON.parse(match[0]);
    // Validate shape
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

