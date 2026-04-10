import type { LlamaJsonSchemaGrammar } from "node-llama-cpp";
import { LLMService } from "../src/LLMService.js";

class WorkerAgent{
    public async getWorkerAgent<T = string>(systemPrompt : string, userPrompt : string, grammar? : LlamaJsonSchemaGrammar<any>, workerName? : string, ) : Promise<T | string> {

        const llm = await LLMService.getInstance();
        const llmSession = (await llm.createSession(systemPrompt));        
        //Instruct (or non-thinking) mode for general tasks: temperature=0.7, top_p=0.8, top_k=20, min_p=0.0, presence_penalty=1.5, repetition_penalty=1.0
        const reply = await llmSession.prompt(userPrompt, {
            ...(grammar ? { grammar } : {})
        });

        if (grammar) {
            const parsedResponse = grammar.parse(reply);
            return parsedResponse as T;
        }
        llm.getSessionContextUsage(llmSession, workerName ? workerName : "workerAgent");
        llm.endSession(llmSession);
        return reply;
    }
}

export const workerAgent = new WorkerAgent();