/// <reference types="node" />

import { LLMService } from "../src/LLMService.js";
import OpenAI from "openai";

export class OpenAISession {
    public messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    
    constructor(private llm: LLMService, systemPrompt: string) {
        this.messages.push({ role: "system", content: systemPrompt });
    }

    public async prompt(userPrompt: string | OpenAI.Chat.Completions.ChatCompletionContentPart[], options: { functions?: Record<string, any> } = {}): Promise<string> {
        this.messages.push({ role: "user", content: userPrompt });

        let tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
        if (options.functions) {
            tools = Object.entries(options.functions).map(([name, tool]) => ({
                type: "function",
                function: {
                    name,
                    description: tool.description,
                    parameters: tool.params || tool.parameters
                }
            }));
        }

        while (true) {
            // @ts-ignore - The SDK expects a specific type for 'tools' array if it is present. We ignore to allow passing our manually mapped list or undefined when empty.
            const response = await this.llm.openai.chat.completions.create({
                model: this.llm.modelName,
                messages: this.messages,
                tools: tools.length > 0 ? (tools as any) : undefined,
                temperature: 0.6,
            });

            const msg = response.choices[0]?.message;
            if (!msg) break;
            this.messages.push(msg);

             if (msg.content) {
                process.stdout.write(`\n\x1b[92mAssistant:\x1b[0m ${msg.content}\n`);
            }

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const toolCall of msg.tool_calls) {
                    const funcCall = (toolCall as any).function;
                    if (!funcCall) continue;
                    
                    process.stdout.write(`\n\x1b[95m[Tool Call]\x1b[0m ${funcCall.name}(${funcCall.arguments})\n`);
                    const funcName = funcCall.name;
                    const args = JSON.parse(funcCall.arguments);
                    
                    if (options.functions && options.functions[funcName] && options.functions[funcName].handler) {
                        try {
                            const result = await options.functions[funcName].handler(args);
                            this.messages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: typeof result === 'string' ? result : JSON.stringify(result)
                            });
                        } catch (e: any) {
                            this.messages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: `Error: ${e.message}`
                            });
                        }
                    } else {
                        this.messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: `Error: Tool ${funcName} not found.`
                        });
                    }
                }
            } else {
                break;
            }
        }
        
        return this.messages[this.messages.length - 1]?.content as string;
    }
}

class WorkerAgent {
    public async getWorkerAgentWithFunctions(systemPrompt: string, userPrompt: string | OpenAI.Chat.Completions.ChatCompletionContentPart[], toolFunction: Record<string, any>, workerName?: string): Promise<string> {
        const llm = await LLMService.getInstance();
        const session = new OpenAISession(llm, systemPrompt);
        return await session.prompt(userPrompt, { functions: toolFunction });
    }
}

export const workerAgent = new WorkerAgent();
