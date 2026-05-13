import { LLMService } from "../src/LLMService.js";
import { ClassificationUtility } from "../src/utils/classificationUtility.js";
import { FileContentExtractor } from "../src/utils/fileContentExtractor.js";
import * as path from 'path';
import { workerAgent } from "./workerAgent.js";

export class FileClassificationTool {
    
    /**
     * Given a list of unclassified files, categorizes them using content and provides folder suggestions.
     */
    public static async clusterAndNameFiles(filePaths: string[]): Promise<Record<string, string[]>> {
        if (filePaths.length === 0) {
            return {};
        }

        const llmService = await LLMService.getInstance();
        console.log(`Generating embeddings for ${filePaths.length} files...`);
        
        try {
            // 1. Extract content and Generate Embeddings
            const embeddings: number[][] = [];
            const contents: string[] = [];
            for (const filePath of filePaths) {
                const content = await FileContentExtractor.extractContent(filePath);
                contents.push(content);
                const embedding = await llmService.generateEmbedding(content, "search_document: ");
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
            
            const sysprompt = "You are an expert file organizer. Given excerpts from representative files titles and its snippets, provide a single, short (1-3 words), highly descriptive folder name that categorize all these files and there contents perfectly. Give a category name that generalizes all the files, not only the specific files. DO NOT output any explanation, bullet points, or quotes, JUST the folder name itself.";
            
            
            for (const [labelStr, fileNames] of Object.entries(clusters)) {
                const label = parseInt(labelStr, 10);
                
                if (label === -1) {
                    // Noise / Unclassified files
                    result['Uncategorized'] = (result['Uncategorized'] || []).concat(fileNames);
                } else if (fileNames.length === 1) {
                    result['Misc'] = (result['Misc'] || []).concat(fileNames);
                } else {
                    // Get snippets of representative files
                    const repIndices = representatives[label.toString()] || [];
                    const repContents = repIndices.map(idx => contents[idx]);
                    const contentToLLM = repContents.length > 0 ? repContents.join('\n\n') : fileNames.join('\n');
                    
                    // Ask LLM to name the folder based on the file contents
                    const prompt = `Representative Files Content:\n${contentToLLM}\n\nWhat should the folder name be? (Only reply with the folder name)`;
                    // const folderName = await namingSession.prompt(prompt, {
                    //     maxTokens: 50
                    // });

                    const folderName = await workerAgent.getWorkerAgentWithFunctionsReact(
                        sysprompt,
                        prompt,
                        {},
                        "file categorize worker"
                    );
                    
                    console.log(`\x1b[36m[LLM Naming]\x1b[0m Cluster ${label} files (${fileNames.length}) -> LLM returned: "${folderName}"`);
                    
                    // Cleanup LLM output to grab just the first line/clean name
                    let cleanFolderName = folderName.trim().replace(/^["']|["']$/g, '').replace(/[/\\?%*:|"<>]/g, '-').split('\n')[0].trim();
                    
                    if (!cleanFolderName || cleanFolderName.length === 0 || cleanFolderName.toLowerCase() === "undefined") {
                        cleanFolderName = `Category_${label}`;
                    }

                    result[cleanFolderName] = (result['Misc'] || []).concat(fileNames);
                    
                }
            }
            
            return result;
            
        } catch (err) {
            console.error("Error during file classification:", err);
            throw err;
        } finally {
            // 4. Dispose embedding model to free memory
            llmService.disposeEmbeddingModel();
        }
    }
}
