import type { LlamaJsonSchemaGrammar } from "node-llama-cpp";
import { LLMService } from "../src/LLMService.js";

class WorkerAgent{
    public async getWorkerAgentWithGrammar<T = string>(systemPrompt : string, userPrompt : string, grammar? : LlamaJsonSchemaGrammar<any>, workerName? : string) : Promise<T | string> {
        const llm = await LLMService.getInstance();
        const llmSession = await llm.createSession(systemPrompt);        
        
        let reply: string;
        if (grammar) {
            reply = await llmSession.prompt(userPrompt, {
                grammar
            });
        } else {
            reply = await llmSession.prompt(userPrompt);
        }

        let parsedResponse: T | string = reply;
        if (grammar) {
            parsedResponse = grammar.parse(reply) as T;
        }

        llm.getSessionContextUsage(llmSession, workerName ? workerName : "workerAgent");
        llm.endSession(llmSession);
        
        return parsedResponse;
    }

    public async getWorkerAgentWithFunctions(systemPrompt : string, userPrompt : string, toolFunction : Record<string, any>, workerName? : string) : Promise<string> {
        const llm = await LLMService.getInstance();
        const llmSession = await llm.createSession(systemPrompt);

        const reply = await llmSession.prompt(userPrompt, {
            functions: toolFunction
        });

        llm.getSessionContextUsage(llmSession, workerName ? workerName : "workerAgent");
        llm.endSession(llmSession);

        return reply;
    }

    public async getWorkerAgentWithFunctionsReact(
        systemPrompt: string,
        userPrompt: string,
        toolFunction: Record<string, any>,
        workerName?: string
    ): Promise<string> {
        const llm = await LLMService.getInstance();
        const llmSession = await llm.createSession(systemPrompt);

        const label = workerName ?? "Worker";
        console.log(`\x1b[95m[${label}]\x1b[0m Starting ReAct loop...`);

        const reply = await llmSession.prompt(userPrompt, {
            functions: toolFunction,
            temperature: 0.3,
            topP: 0.9,
            topK: 20,
        });

        const usage = llm.getSessionContextUsage(llmSession, label);
        console.log(`\x1b[95m[${label}]\x1b[0m Done. Tokens used: ${usage.usedTokens}/${usage.totalTokens}`);

        llm.endSession(llmSession);
        return reply;
    }
}

export const workerAgent = new WorkerAgent();