import type { LlamaJsonSchemaGrammar } from "node-llama-cpp";
import { LLMService } from "../src/LLMService.js";

class WorkerAgent{
    public async getWorkerAgentWithGrammar<T = string>(systemPrompt : string, userPrompt : string, grammar? : LlamaJsonSchemaGrammar<any>, workerName? : string) : Promise<T | string> {
        const llm = await LLMService.getInstance();
        const llmSession = await llm.createSession(systemPrompt);   
        
        let reply: string;
        if (grammar) {
            reply = await llmSession.prompt(userPrompt, {
                grammar,
                onResponseChunk(chunk) {
                    const isThoughtSegment = chunk.type === "segment" &&
                        chunk.segmentType === "thought";
                    const isCommentSegment = chunk.type === "segment" &&
                        chunk.segmentType === "comment";
                    
                    if (chunk.type === "segment" && chunk.segmentStartTime != null)
                        process.stdout.write(` [segment start: ${chunk.segmentType}] `);

                    process.stdout.write(chunk.text);

                    if (chunk.type === "segment" && chunk.segmentEndTime != null)
                        process.stdout.write(` [segment end: ${chunk.segmentType}] `);
                }
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
            functions: toolFunction,
            onResponseChunk(chunk) {
                    const isThoughtSegment = chunk.type === "segment" &&
                        chunk.segmentType === "thought";
                    const isCommentSegment = chunk.type === "segment" &&
                        chunk.segmentType === "comment";
                    
                    if (chunk.type === "segment" && chunk.segmentStartTime != null)
                        process.stdout.write(` [segment start: ${chunk.segmentType}] `);

                    process.stdout.write(chunk.text);

                    if (chunk.type === "segment" && chunk.segmentEndTime != null)
                        process.stdout.write(` [segment end: ${chunk.segmentType}] `);
                }
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
        const maxThoughtTokens = 200;
        const reply = await llmSession.prompt(userPrompt, {
            functions: toolFunction,
            budgets: {
                thoughtTokens: maxThoughtTokens
            },
            onResponseChunk(chunk) {
                    const isThoughtSegment = chunk.type === "segment" &&
                        chunk.segmentType === "thought";
                    const isCommentSegment = chunk.type === "segment" &&
                        chunk.segmentType === "comment";
                    
                    if (chunk.type === "segment" && chunk.segmentStartTime != null)
                        process.stdout.write(` [segment start: ${chunk.segmentType}] `);

                    process.stdout.write(chunk.text);

                    if (chunk.type === "segment" && chunk.segmentEndTime != null)
                        process.stdout.write(` [segment end: ${chunk.segmentType}] `);
                }
        });

        const usage = llm.getSessionContextUsage(llmSession, label);
        console.log(`\x1b[95m[${label}]\x1b[0m Done. Tokens used: ${usage.usedTokens}/${usage.totalTokens}`);

        llm.endSession(llmSession);
        return reply;
    }
}

export const workerAgent = new WorkerAgent();