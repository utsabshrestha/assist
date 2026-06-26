import { spawn } from 'child_process';
import * as path from 'path';
import { dedupCategoryPrompt } from '../prompt/fileAgent.js';

const DEDUP_CHUNK_SIZE = 9;

interface DedupMerge {
    source: string;
    target: string;
}

interface LlmChatClient {
    openai: {
        chat: {
            completions: {
                create: (params: any) => Promise<any>;
            };
        };
    };
    modelName: string;
}

function parseDedupeOutput(raw: string): { merges: DedupMerge[] } {
    // Extract first JSON object found, even if model adds trailing text
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

async function requestMergesForChunk(folderNames: string[], llmService: LlmChatClient): Promise<DedupMerge[]> {
    if (folderNames.length <= 1) return [];

    const userDedupPrompt = `Review and deduplicate this folder list. Output only the JSON merges object.

Folders:
${JSON.stringify(folderNames, null, 2)}

JSON:`;

    try {
        const response = await llmService.openai.chat.completions.create({
            model: llmService.modelName,
            messages: [
                { role: "system", content: dedupCategoryPrompt },
                { role: "user", content: userDedupPrompt }
            ],
        });

        const dedupeResult = response.choices[0]?.message?.content || "";
        return parseDedupeOutput(dedupeResult).merges;
    } catch (e) {
        console.error("Error during category de-duplication:", e);
        return [];
    }
}

export class ClassificationUtility {

    /**
     * Deduplicates/generalizes a list of category names using the LLM, in chunks rather
     * than a single call over the entire list — small models lose accuracy reasoning over
     * long, open-ended lists in one shot. Cross-chunk duplicates are caught by re-running
     * the same process over the merged result until it stops shrinking, or the list fits
     * in one chunk.
     */
    public static async deduplicateCategories(folderNames: string[], llmService: LlmChatClient): Promise<DedupMerge[]> {
        if (folderNames.length <= 1) return [];

        const allMerges: DedupMerge[] = [];
        let currentNames = folderNames;

        for (let pass = 0; pass < 2 && currentNames.length > 1; pass++) {
            const chunks: string[][] = [];
            for (let i = 0; i < currentNames.length; i += DEDUP_CHUNK_SIZE) {
                chunks.push(currentNames.slice(i, i + DEDUP_CHUNK_SIZE));
            }

            const passMerges: DedupMerge[] = [];
            for (const chunk of chunks) {
                const merges = await requestMergesForChunk(chunk, llmService);
                passMerges.push(...merges);
            }

            if (passMerges.length === 0) break;
            allMerges.push(...passMerges);

            // Simulate applying merges to get the next pass's candidate list
            const nameSet = new Set(currentNames);
            for (const merge of passMerges) {
                if (nameSet.has(merge.source) && merge.source !== merge.target) {
                    nameSet.delete(merge.source);
                    nameSet.add(merge.target);
                }
            }
            const nextNames = Array.from(nameSet);

            // Only worth another pass if the list shrank and is still multi-chunk
            if (nextNames.length >= currentNames.length || chunks.length <= 1) {
                break;
            }
            currentNames = nextNames;
        }

        return allMerges;
    }
    
    /**
     * Takes an array of embeddings and uses a Python HDBSCAN script to cluster them.
     * Returns an array of cluster labels corresponding to each embedding.
     * A label of -1 indicates "noise" (no cluster).
     */
    public static async clusterEmbeddings(embeddings: number[][]): Promise<{ labels: number[], representatives: Record<string, number[]> }> {
        return new Promise((resolve, reject) => {
            if (!embeddings || embeddings.length === 0) {
                return resolve({ labels: [], representatives: {} });
            }

            const scriptPath = path.resolve(process.cwd(), 'scripts/cluster.py');
            const pythonExecutable = path.resolve(process.cwd(), '.venv/bin/python3');
            
            const pythonProcess = spawn(pythonExecutable, [scriptPath]);
            
            let outputData = '';
            let errorData = '';

            pythonProcess.stdout.on('data', (data) => {
                outputData += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorData += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Python clustering script failed (code ${code}): ${errorData}`));
                }
                try {
                    const result = JSON.parse(outputData);
                    if (result.error) {
                        return reject(new Error(`Clustering error: ${result.error}`));
                    }
                    if (Array.isArray(result)) {
                        // Backwards compatibility if python scripts returns array
                        resolve({ labels: result, representatives: {} });
                    } else {
                        resolve(result);
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse clustering output.\nPython code: ${code}\nStderr: ${errorData}\nStdout: ${outputData}`));
                }
            });

            // Prevent Node.js from crashing if the Python process immediately dies
            pythonProcess.stdin.on('error', (err) => {
                console.error("Failed to write to python process. It might have crashed on startup.", err);
            });

            // Send standard input
            const inputJson = JSON.stringify(embeddings);
            pythonProcess.stdin.write(inputJson);
            pythonProcess.stdin.end();
        });
    }
}