import * as readline from 'readline/promises';
import { fileOrgMastertools } from '../tools/fileOrgTool.js';
import { LLMService } from './LLMService.js';
import { fileOrgMasterAgentSystemPrompt } from './prompt/fileAgent.js';
import { fileAgentRecord, fileAgentState } from './state/fileAgentState.js';

class FileAgent {
    readonly path: string = process.env.WORKSPACE_PATH ?? "/Users/utsabshrestha/code/download";
    public async chatLoop() {

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        console.log("\n\x1b[93m[System]\x1b[0m Loading node-llama-cpp (Apple Metal GPU enabled automatically)...");
        
        const state = new fileAgentState();
        const processId = crypto.randomUUID();
        state.processId = processId;
        fileAgentRecord[processId] = state;
        
        const FileOrganizeSystemPrompt = `${fileOrgMasterAgentSystemPrompt}\n\nProcessId: ${processId}`;
        const llm = await LLMService.getInstance();
        const llmSession = await llm.createSession(FileOrganizeSystemPrompt);

        console.log("\n\x1b[92m=== File Organization Agent ===\x1b[0m");
        console.log("Agent is ready. Describe how you want to manage your files.");
        console.log("Type 'exit' to quit.\n");

        while (true) {
            const userInput = await rl.question("\x1b[94mUser:\x1b[0m ");
            if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') break;


            process.stdout.write("\x1b[96mAgent:\x1b[0m ");
            await llmSession.prompt(userInput, {
                functions: fileOrgMastertools,
                temperature: 0.6,
                topP: 0.9,
                topK: 20,
                onTextChunk: (chunk) => {
                    process.stdout.write(chunk);
                }
            });
            console.log("\n");
        }
        llm.endSession(llmSession);
        rl.close();
    }
}

export const fileAgent = new FileAgent();
fileAgent.chatLoop().catch(console.error);