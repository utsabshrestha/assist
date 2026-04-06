import { getLlama, Llama, LlamaChatSession, LlamaContext, LlamaModel } from "node-llama-cpp";

export class LLMService {
    private static instance: LLMService | null = null;

    public model!: LlamaModel;
    public context!: LlamaContext;
    public llama!: Llama;

    private constructor() {}
    
    public static async getInstance(): Promise<LLMService> {
        if (!LLMService.instance){
            const service = new LLMService();
            await service.initialize();
            LLMService.instance = service;
        }
        return LLMService.instance;
    }
    private async initialize() {
        this.llama = await getLlama();
        this.model = await this.llama.loadModel({ 
            modelPath: "./Qwen3.5-9B-Q5_K_M.gguf" 
        });
        
        this.context = await this.model.createContext({
            contextSize: 16000,
            sequences: 2,
            batchSize: 512, // Larger batch size for faster prompt processing
            flashAttention: true // VITAL for large contexts: drastically reduces memory and speeds up inference
        });
    }
    public async createSession(systemPrompt: string) : Promise<LlamaChatSession> {
        const sequence = this.context.getSequence();
        return new LlamaChatSession({
            contextSequence: sequence,
            systemPrompt: systemPrompt,
            contextShift: {
                size: Math.max(1, Math.floor(16000 / 10)), // Free up 10% of space when full
                strategy: "eraseFirstResponseAndKeepFirstSystem" // Options: "eraseFirst" (default) or "summarize"
            }
        });
    }

    public endSession(session: LlamaChatSession) {
        const sequence = session.sequence;
        session.dispose();
        if (sequence) sequence.dispose();
        console.log("Tokens successfully returned to the context pool.");
    }

    public checkContextUsage(session: LlamaChatSession) {
        // The current number of tokens loaded into the sequence
        const usedTokens = session.sequence.nextTokenIndex; 
        
        // The maximum capacity for this sequence/context
        const totalTokens = session.sequence.contextSize; 
        
        const usagePercentage = ((usedTokens / totalTokens) * 100).toFixed(2);
        
        console.log(`Context Usage: ${usedTokens} / ${totalTokens} tokens (${usagePercentage}%)`);
        
        return {
            used: usedTokens,
            total: totalTokens,
            percentage: usagePercentage
        };
    }

        public checkGlobalContextStatus() {
        if (!this.context) {
            console.warn("Context is not initialized.");
            return null;
        }

        // Maximum total capacity allocated to this context 
        const maxContextSize = this.context.contextSize;
        
        // Sum of context size allocated by the currently active sequences
        const allocatedContextSize = this.context.getAllocatedContextSize();
        
        // How many sequences you can currently create
        const sequencesLeft = this.context.sequencesLeft;
        
        // Total maximum sequences this context allowed (from your initialization, it's 2)
        const totalSequences = this.context.totalSequences;

        console.log(`--- Global Context Pool Status ---`);
        console.log(`Tokens Allocated: ${allocatedContextSize} / ${maxContextSize}`);
        console.log(`Sequences Available: ${sequencesLeft} / ${totalSequences}`);
        
        return {
            maxContextSize,
            allocatedContextSize,
            sequencesLeft,
            totalSequences
        };
    }
}