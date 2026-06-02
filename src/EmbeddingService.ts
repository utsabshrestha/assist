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
        this._context = await this._model.createEmbeddingContext();
        console.log("Embedding model loaded successfully.");
    }

    public async generateEmbedding(text: string, taskPrefix = "search_document: "): Promise<number[]> {
        if (!this._context) {
            throw new Error("Embedding context not initialized");
        }
        try {
            const embedding = await this._context.getEmbeddingFor(taskPrefix + text);
            // Convert Float32Array/Float64Array to regular standard array for easy JSON serialization
            return Array.from(embedding.vector);
        } catch (error) {
            console.error("Error generating local embedding:", error);
            return [];
        }
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
