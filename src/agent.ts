import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline/promises';
import { getLlama, LlamaChatSession, defineChatSessionFunction } from "node-llama-cpp";
import {tools } from '../tools/fileOrgTool.js'
import { LLMService } from './LLMService.js';
import { fileOrgMasterAgentSystemPrompt } from './prompt/fileAgent.js';

class FileAgent {    
    private dangerousActions = ["create_folder", "move_file"];
    readonly path : string = "/Users/utsabshrestha/code/download";
    public async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log("\n\x1b[93m[System]\x1b[0m Loading node-llama-cpp (Apple Metal GPU enabled automatically)...");
        
        const llm = await LLMService.getInstance();
        const llmSession = await llm.createSession(fileOrgMasterAgentSystemPrompt);

        console.log("\n\x1b[92m=== File Organization Agent ===\x1b[0m");
        console.log("Agent is ready. Describe how you want to manage your files.");
        console.log("Type 'exit' to quit.\n");

        while (true) {
            const userInput = await rl.question("\x1b[94mUser:\x1b[0m ");
            if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') break;

            let nextInput = `userInput \n\n ProcessId: ${crypto.randomUUID()}`;

            while (true) {
                process.stdout.write("\x1b[96mAgent:\x1b[0m ");
                
                // Directly stream responses from the in-memory LLM!
                const reply = await llmSession.prompt(nextInput, {
                    functions: tools,
                    temperature: 1,
                    topP:0.95,
                    topK: 20,
                    minP: 0.0,
                    onTextChunk: (chunk) => {
                        process.stdout.write(chunk);
                    }
                });
                console.log("\n");
                break;

            }
        }
        llm.endSession(llmSession);
        rl.close();
    }
}

export const fileAgent = new FileAgent();
fileAgent.chatLoop().catch(console.error);