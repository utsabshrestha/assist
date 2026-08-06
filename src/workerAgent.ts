/// <reference types="node" />

import { LLMService } from "./LLMService.js";
import { Agent, tool as createAgentTool } from "@openai/agents";
import OpenAI from "openai";
import { emitAgentMessage, emitLog } from "../electron/ipcBridge.js";

export class OpenAISession {
    public messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    private agent: Agent | null = null;

    constructor(private llm: LLMService, private systemPrompt: string) {
        this.messages.push({ role: "system", content: systemPrompt });
    }

    public async prompt(userPrompt: string | OpenAI.Chat.Completions.ChatCompletionContentPart[], options: { functions?: Record<string, any>, forceToolUse?: boolean } = {}): Promise<string> {
        this.messages.push({ role: "user", content: userPrompt });

        let tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
        const agentTools: any[] = [];

        if (options.functions) {
            tools = Object.entries(options.functions).map(([name, tool]) => ({
                type: "function",
                function: {
                    name,
                    description: tool.description,
                    parameters: tool.params || tool.parameters
                }
            }));

            for (const [name, toolDef] of Object.entries(options.functions)) {
                agentTools.push(createAgentTool({
                    name,
                    description: toolDef.description || name,
                    parameters: toolDef.params || toolDef.parameters || { type: "object", properties: {} },
                    execute: async (args: any) => {
                        if (toolDef.handler) {
                            return await toolDef.handler(args);
                        }
                        return "Success";
                    }
                }));
            }
        }

        // Initialize @openai/agents Agent instance representation
        this.agent = new Agent({
            name: "WorkerAgent",
            instructions: this.systemPrompt,
            model: this.llm.agentModel,
            tools: agentTools
        });

        const toolNames = Object.keys(options.functions || {});
        let noToolCallRetries = 0;
        const MAX_NO_TOOL_CALL_RETRIES = 3;
        let madeAnyToolCallThisPrompt = false;

        while (true) {
            // @ts-ignore
            const response = await this.llm.openai.chat.completions.create({
                model: this.llm.modelName,
                messages: this.messages,
                tools: tools.length > 0 ? (tools as any) : undefined,
                temperature: 0.6,
            });

            const msg = response.choices[0]?.message;
            if (!msg) break;

            const hasToolCalls = !!msg.tool_calls && msg.tool_calls.length > 0;

            if (options.forceToolUse && !hasToolCalls && !madeAnyToolCallThisPrompt && noToolCallRetries < MAX_NO_TOOL_CALL_RETRIES) {
                noToolCallRetries++;
                this.messages.push(msg);
                emitLog(`Worker replied with text instead of a tool call (retry ${noToolCallRetries}/${MAX_NO_TOOL_CALL_RETRIES})`, 'error');
                this.messages.push({
                    role: "user",
                    content: `You must respond ONLY by calling one of these tools: ${toolNames.join(', ')}. Do not reply with plain text. Call the appropriate tool now.`
                });
                continue;
            }

            this.messages.push(msg);

            if (msg.content && options.forceToolUse == false) {
                // Route assistant messages to the main chat panel
                emitAgentMessage(msg.content, 'agent');
            }

            if (msg.tool_calls && msg.tool_calls.length > 0) {
                madeAnyToolCallThisPrompt = true;
                for (const toolCall of msg.tool_calls) {
                    const funcCall = (toolCall as any).function;
                    if (!funcCall) continue;

                    // Log tool calls to the side panel
                    emitLog(`${funcCall.name}(${funcCall.arguments})`, 'tool_call', funcCall.name);

                    const funcName = funcCall.name;
                    const args = JSON.parse(funcCall.arguments);

                    if (options.functions && options.functions[funcName] && options.functions[funcName].handler) {
                        try {
                            const result = await options.functions[funcName].handler(args);
                            const toolResultContent = typeof result === 'string' ? result : JSON.stringify(result);
                            this.messages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: toolResultContent
                            });

                            // Log tool results to the side panel
                            emitLog(toolResultContent.slice(0, 500) + (toolResultContent.length > 500 ? '...' : ''), 'tool_result', funcName);

                            // Pipeline sentinel: a handoff tool signals we should exit this loop
                            if (toolResultContent.startsWith("__HANDOFF_")) {
                                return toolResultContent;
                            }
                            else if (toolResultContent.startsWith("__ERROR_")) {
                                return toolResultContent;
                            }
                            else if (toolResultContent === "__Execution_Decline__") {
                                return toolResultContent;
                            }
                        } catch (e: any) {
                            const errMsg = `Error: ${e.message}`;
                            this.messages.push({
                                role: "tool",
                                tool_call_id: toolCall.id,
                                content: errMsg
                            });
                            emitLog(errMsg, 'error', funcName);
                        }
                    } else {
                        const errMsg = `Error: Tool ${funcName} not found.`;
                        this.messages.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: errMsg
                        });
                        emitLog(errMsg, 'error');
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

