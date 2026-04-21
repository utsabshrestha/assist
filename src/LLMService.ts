import { getLlama, Llama, LlamaChatSession, LlamaContext, LlamaModel } from "node-llama-cpp";

export class LLMService {
    private static instance: LLMService | null = null;
    readonly model_1 = './Qwen3.5-9B-Q5_K_M.gguf';
    readonly model_2 = './Qwen3.5-4B-Q4_K_M.gguf';
    public model!: LlamaModel;
    public context!: LlamaContext;
    public llama!: Llama;

    private constructor() { }
    public sessions : LlamaChatSession[] = [];

    public static async getInstance(): Promise<LLMService> {
        if (!LLMService.instance) {
            const service = new LLMService();
            await service.initialize();
            LLMService.instance = service;
        }
        return LLMService.instance;
    }
    private async initialize() {
        this.llama = await getLlama();
        this.model = await this.llama.loadModel({
            // modelPath: "./Qwen3.5-9B-Q5_K_M.gguf"
            modelPath: this.model_2
        });

        
        this.context = await this.model.createContext({
            sequences: 4,
            batchSize: 512, // Larger batch size for faster prompt processing
            flashAttention: true // VITAL for large contexts: drastically reduces memory and speeds up inference
        });
        console.log("Context Size:", this.context.contextSize);
    }
    public async createSession(systemPrompt: string): Promise<LlamaChatSession> {
        if(!LLMService.instance){
            throw new Error("LLM Sercie is not instantiated !");
        }
        const sequence = this.context.getSequence();
        const newSession = new LlamaChatSession({
            contextSequence: sequence,
            systemPrompt: systemPrompt,
            contextShift: {
                size: Math.max(1, Math.floor(16000 / 10)), // Free up 10% of space when full
                strategy: "eraseFirstResponseAndKeepFirstSystem" // Options: "eraseFirst" (default) or "summarize"
            }
        });
        this.sessions.push(newSession);
        return newSession;
    }

    public endSession(session: LlamaChatSession) {
        const sequence = session.sequence;
        session.dispose();
        if (sequence) sequence.dispose();
        this.sessions = this.sessions.filter(ses => ses.disposed == false);
        console.log("Tokens successfully returned to the context pool.");
    }

    /**
     * Get context window usage for a specific session.
     * Uses .contextTokens (the actual live KV-cache token array) for current fill level,
     * and .tokenMeter for cumulative input/output token counts.
     */
    public getSessionContextUsage(session: LlamaChatSession, name?: string) {
        const sequence = session.sequence;

        // contextTokens = the actual tokens currently loaded in the KV-cache for this sequence
        const usedTokens = sequence.contextTokens.length;
        const totalTokens = sequence.contextSize; // per-sequence context window size

        return {
            name: name ?? "session",
            usedTokens,
            totalTokens,
            freeTokens: totalTokens - usedTokens,
            usedPercentage: parseFloat(((usedTokens / totalTokens) * 100).toFixed(2)),
            // Cumulative totals since the sequence was created (survives context shifts)
            cumulativeInputTokens: sequence.tokenMeter.usedInputTokens,
            cumulativeOutputTokens: sequence.tokenMeter.usedOutputTokens,
        };
    }

    /**
     * Get global context usage by summing the live KV-cache tokens across all sequences.
     * Pass in all your active sessions so we can sum their actual usage.
     */
    public getGlobalContextUsage(context: LlamaContext) {
        const totalTokens = context.contextSize; // total across all sequences combined

        // Sum the actual KV-cache usage from each sequence — this is the ground truth
        const usedTokens = this.sessions.reduce(
            (sum, s) => sum + s.sequence.contextTokens.length,
            0
        );

        return {
            usedTokens,
            totalTokens,
            freeTokens: totalTokens - usedTokens,
            usedPercentage: parseFloat(((usedTokens / totalTokens) * 100).toFixed(2)),
        };
    }

    /**
     * Pretty-print a full usage report.
     */
    public printContextReport(
        context: LlamaContext,
        sessions: { name: string; session: LlamaChatSession }[]
    ) {
        console.log("\n========== CONTEXT USAGE REPORT ==========");

        const global = this.getGlobalContextUsage(context);
        console.log(`\n[Global] ${global.usedTokens} / ${global.totalTokens} tokens (${global.usedPercentage}% used, ${global.freeTokens} free)`);

        for (const { name, session } of sessions) {
            const s = this.getSessionContextUsage(session, name);
            console.log(`\n[${s.name}]`);
            console.log(`  Live context:  ${s.usedTokens} / ${s.totalTokens} tokens (${s.usedPercentage}% used, ${s.freeTokens} free)`);
            console.log(`  Cumulative in: ${s.cumulativeInputTokens} tokens evaluated`);
            console.log(`  Cumulative out: ${s.cumulativeOutputTokens} tokens generated`);
        }

        console.log("\n==========================================\n");
    }
}