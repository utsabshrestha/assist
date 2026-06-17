import OpenAI from "openai";
import { ApiConfig } from "./ApiConfig.js";

export class LLMService {
    private static instance: LLMService | null = null;
    
    // We point to the local LLaMA.cpp HTTP Server. Default port is 8080.
    public openai: OpenAI;
    public modelName = "local-model"; // llama-server ignores this or uses loaded model

    private constructor() {
        this.openai = new OpenAI({
            baseURL: ApiConfig.llmApiEndpoint,
            apiKey: ApiConfig.llmApiKey, // Required by SDK, ignored by llama-server by default
        });
    }

    public static async getInstance(): Promise<LLMService> {
        if (!LLMService.instance) {
            LLMService.instance = new LLMService();
        }
        return LLMService.instance;
    }

    /**
     * Helper to initialize a message array for managing the conversational context.
     */
    public createMessageHistory(systemPrompt: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        return [
            { role: "system", content: systemPrompt }
        ];
    }
}
