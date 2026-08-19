import { spawn } from 'child_process';
import * as path from 'path';
import { dedupCategoryPrompt } from '../prompt/fileAgent.js';
import { Readable } from 'stream';
import { emitLog } from '../../electron/ipcBridge.js';

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
            temperature: 0.2,
            // See fileClassificationTool.ts for both of these: cache_prompt avoids
            // cross-session KV cache slot reuse; max_tokens gives the model real
            // room to finish reasoning before answering, instead of truncating
            // mid-thought with empty content.
            // @ts-ignore - llama.cpp passthrough extra, not in the OpenAI SDK types
            cache_prompt: false,
            max_tokens: 800,
            // @ts-ignore - llama.cpp's OpenAI-compatible server accepts repeat_penalty as a passthrough extra
            repeat_penalty: 1.3,
        });

        const message: any = response.choices[0]?.message;
        const dedupeResult = message?.content || message?.reasoning_content || "";

        emitLog(JSON.stringify({
            folderNames: folderNames,
            dedupResult: dedupeResult,
        }), 'info', 'Topic Name Deduplication Agent');

        return parseDedupeOutput(dedupeResult).merges;
    } catch (e) {
        console.error("Error during category de-duplication:", e);
        return [];
    }
}

/**
 * Extracts the model's final answer from a chat message that reasons in free text
 * before emitting <output>...</output>. Falls back to best-effort cleanup (stripping
 * <think>/<output> scaffolding) if the model never closed the tag, since reasoning
 * models inconsistently keep chain-of-thought in `content` vs. `reasoning_content`.
 */
export function extractTaggedOutput(message: { content?: string; reasoning_content?: string } | undefined): string {
    const text = message?.content || message?.reasoning_content || "";
    const match = text.match(/<output>([\s\S]*?)<\/output>/i);
    if (match?.[1]) return match[1].trim();
    return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<output>/gi, '').trim();
}

/**
 * Last-resort recovery when the model rambled without ever closing <output> (common
 * with small reasoning models that lose track of formatting over long chains of thought).
 * Feeds its own text back with a terse "just extract the name" instruction rather than
 * silently falling back to a generic Category_N name. Returns null if the repair attempt
 * also fails to produce a tagged name — callers should fall back to a generic name then.
 */
export async function repairTaggedOutput(rawText: string, llmService: LlmChatClient): Promise<string | null> {
    if (!rawText.trim()) return null;

    try {
        const response = await llmService.openai.chat.completions.create({
            model: llmService.modelName,
            messages: [
                {
                    role: "system",
                    content: "You extract a folder name from another model's leftover output. Respond with ONLY the folder name wrapped in <output></output> tags. Nothing else."
                },
                {
                    role: "user",
                    content: `Leftover output (it never closed its <output> tag):\n${rawText}\n\nExtract the folder name it was converging on, in Title_Case_With_Underscores, 1-4 words. Respond with <output>Name</output> only.`
                }
            ],
            temperature: 0,
            // @ts-ignore - llama.cpp passthrough extra, not in the OpenAI SDK types
            cache_prompt: false,
            // Tight budget — this is extraction, not reasoning. A reasoning model given
            // room here will start re-reasoning instead of just answering.
            max_tokens: 60,
            // @ts-ignore - llama.cpp's OpenAI-compatible server accepts repeat_penalty as a passthrough extra
            repeat_penalty: 1.1,
        });

        const message: any = response.choices[0]?.message;
        const repaired = extractTaggedOutput(message);
        emitLog(JSON.stringify({
            rawText: rawText,
            repaired: repaired,
            info: "Successfully repaired the output tag"
        }), 'info', 'Topic Repairing Agent');
        return repaired || null;
    } catch (e) {
        console.error("Error during folder name repair pass:", e);
        return null;
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
     * 
     * @depreciated This function is not used anymore, the embeddings happens in the MCP server which uses BerTopic Algorithm. 
     * 
     */
    public static async clusterEmbeddings(
        embeddings: number[][],
        texts?: string[]
    ): Promise<{
        labels: number[];
        representatives: Record<string, number[]>; // cluster_id -> up to 4 member indices, Core -> Edge
        outlierCounts: Record<string, number>;
        keywords: Record<string, string[]>;         // cluster_id -> top c-TF-IDF keywords
        clusterSizes: Record<string, number>;
        fileDiagnostics: Record<string, unknown>;
    }> {
        return new Promise((resolve, reject) => {
            if (!embeddings || embeddings.length === 0) {
                return resolve({ labels: [], representatives: {}, outlierCounts: {}, keywords: {}, clusterSizes: {}, fileDiagnostics: {} });
            }

            const scriptPath = path.resolve(process.cwd(), 'scripts/clusterV3.py');
            const pythonExecutable = path.resolve(process.cwd(), '.venv/bin/python3');

            const pythonProcess = spawn(pythonExecutable, [scriptPath]);

            // Using Buffer arrays to avoid memory fragmentation/leaks with large strings
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            pythonProcess.stdout.on('data', (data: Buffer) => {
                stdoutChunks.push(data);
            });

            pythonProcess.stderr.on('data', (data: Buffer) => {
                stderrChunks.push(data);
            });

            pythonProcess.on('close', (code) => {
                const outputData = Buffer.concat(stdoutChunks).toString();
                const errorData = Buffer.concat(stderrChunks).toString();

                if (code !== 0) {
                    return reject(new Error(`Python clustering script failed (code ${code}): ${errorData}`));
                }
                try {
                    const result = JSON.parse(outputData);
                    if (result.error) {
                        return reject(new Error(`Clustering error: ${result.error}`));
                    }
                    if (Array.isArray(result)) {
                        // Backwards compatibility if the python script returns a bare array
                        resolve({ labels: result, representatives: {}, outlierCounts: {}, keywords: {}, clusterSizes: {}, fileDiagnostics: {} });
                    } else {
                        resolve({
                            labels: result.labels ?? [],
                            representatives: result.representatives ?? {},
                            outlierCounts: result.outlierCounts ?? {},
                            keywords: result.keywords ?? {},
                            clusterSizes: result.clusterSizes ?? {},
                            fileDiagnostics: result.fileDiagnostics ?? {}
                        });
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse clustering output.\nPython code: ${code}\nStderr: ${errorData}\nStdout: ${outputData}`));
                }
            });

            // Prevent Node.js from crashing if the Python process immediately dies
            pythonProcess.stdin.on('error', (err) => {
                console.error("Failed to write to python process. It might have crashed on startup.", err);
            });

            // texts must be the same length/order as embeddings -- cluster.py zips
            // them positionally to build each cluster's c-TF-IDF pseudo-document.
            const inputJson = JSON.stringify({ embeddings, texts });

            // Streams the data safely into stdin. This avoids buffer overflows (backpressure)
            // and automatically invokes .end() on completion.
            Readable.from([inputJson]).pipe(pythonProcess.stdin);
        });
    }

    /**
     * Labels a representative's position in the distance-to-centroid spread that
     * cluster.py samples across (index 0 = Core/most typical, last index = Edge/most
     * atypical). Mirrors the spread cluster.py computes via np.linspace so the label
     * matches what was actually sampled.
     */
    public static describeRepresentativePosition(index: number, total: number): string {
        if (total <= 1) return 'Core';
        if (index === 0) return 'Core';
        if (index === total - 1) return 'Edge';
        return `Mid-${index}`;
    }
}