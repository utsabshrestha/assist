import * as readline from 'readline/promises';
import { fileOrgMastertools } from '../tools/fileOrgTool.js';
import { LLMService } from './LLMService.js';
import { fileOrgMasterAgentSystemPrompt } from './prompt/fileAgent.js';
import { fileAgentRecord, fileAgentState } from './state/fileAgentState.js';
import { OpenAISession } from '../tools/workerAgent.js';

class FileAgent {
    readonly path: string = process.env.WORKSPACE_PATH ?? "/Users/utsabshrestha/code/download";
    public async chatLoop() {
        console.log("\n\x1b[93m[System]\x1b[0m Loading LLM Server via OpenAI SDK...");
        
        const state = new fileAgentState();
        const processId = crypto.randomUUID();
        state.processId = processId;
        fileAgentRecord[processId] = state;
        
        const FileOrganizeSystemPrompt = fileOrgMasterAgentSystemPrompt(processId);
        const llm = await LLMService.getInstance();
        const session = new OpenAISession(llm, FileOrganizeSystemPrompt);

        console.log("\n\x1b[92m=== File Organization Agent ===\x1b[0m");
        console.log("Agent is ready. Describe how you want to manage your files.");
        console.log("Type 'exit' to quit.\n");

        while (true) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const userInput = await rl.question("\x1b[94mUser:\x1b[0m ");
            rl.close();

            if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') break;

            await session.prompt(userInput, {
                functions: fileOrgMastertools
            });
            console.log("\n");
        }
    }
}

export const fileAgent = new FileAgent();
fileAgent.chatLoop().catch(console.error);
