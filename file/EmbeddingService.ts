import { getLlama } from "node-llama-cpp";
import path from "path";

export class EmbeddingService {
    private static instance: EmbeddingService | null = null;
    private _context: any = null;
    private _model: any = null;

    private constructor() {}

    public static async getInstance(): Promise<EmbeddingService> {
        if (!EmbeddingService.instance) {
            EmbeddingService.instance = new EmbeddingService();
            await EmbeddingService.instance.init();
        } else if (!EmbeddingService.instance._context) {
            // Re-initialize if previously disposed
            await EmbeddingService.instance.init();
        }
        return EmbeddingService.instance;
    }

    private async init() {
        console.log("Loading nomic-embed-text-v1.5.Q6_K.gguf via node-llama-cpp...");
        const llama = await getLlama();
        const modelPath = path.resolve(process.cwd(), "nomic-embed-text-v1.5.Q6_K.gguf");
        this._model = await llama.loadModel({ modelPath });
        
        // Explicitly cap the context size to 4096 tokens
        this._context = await this._model.createEmbeddingContext({
            contextSize: 4096
        });
        
        console.log("Embedding model loaded successfully.");
    }

    public async generateEmbedding(text: string, taskPrefix = "clustering : "): Promise<number[]> {
        if (!this._context) {
            throw new Error("Embedding context not initialized");
        }
        try {
            if(text.substring(0, taskPrefix.length) !== taskPrefix) {
                text = taskPrefix + text;
            }
            const embedding = await this._context.getEmbeddingFor(text);
            // Convert Float32Array/Float64Array to regular standard array for easy JSON serialization
            const vector = Array.from(embedding.vector) as number[];
            
            // L2-normalize vector
            let sumSq = 0;
            for (let i = 0; i < vector.length; i++) {
                sumSq += vector[i] * vector[i];
            }
            const norm = Math.sqrt(sumSq);
            if (norm > 0) {
                for (let i = 0; i < vector.length; i++) {
                    vector[i] /= norm;
                }
            }
            return vector;
        } catch (error) {
            console.error("Error generating local embedding:", error);
            return [];
        }
    }

    public async generateEmbeddings(
        texts: string[],
        taskPrefix = "clustering : ",
        onProgress?: (completed: number, total: number) => void
    ): Promise<number[][]> {
        const results: number[][] = [];
        for (let i = 0; i < texts.length; i++) {
            const emb = await this.generateEmbedding(texts[i], taskPrefix);
            results.push(emb);
            if (onProgress) {
                onProgress(i + 1, texts.length);
            }
        }
        return results;
    }

    public tokenize(text: string): number[] {
        if (!this._model) {
            throw new Error("Embedding model not initialized");
        }
        return this._model.tokenize(text);
    }

    public countTokens(text: string): number {
        return this.tokenize(text).length;
    }

    public dispose() {
        if (this._context) {
            this._context.dispose();
            this._context = null;
        }
        if (this._model) {
            this._model.dispose();
            this._model = null;
        }
        EmbeddingService.instance = null;
        console.log("Embedding resources fully disposed to free RAM.");
    }
}
