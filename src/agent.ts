import * as readline from 'readline/promises';
import { LLMService } from './LLMService.js';
import {
    planningAgentSystemPrompt,
    categorizationAgentSystemPrompt,
    executionAgentSystemPrompt
} from './prompt/fileAgent.js';
import { fileAgentRecord, fileAgentState } from './state/fileAgentState.js';
import { OpenAISession } from './workerAgent.js';
import {
    HANDOFF_CATEGORIZATION_SENTINEL,
    HANDOFF_EXECUTION_SENTINEL
} from '../tools/pipelineTools.js';
import { PlanningTools } from '../tools/planningAgentTools.js';
import { CategorizationTools } from '../tools/categorizationAgentTools.js';
import { ExecutionTools } from '../tools/executionAgentTools.js';

class FileAgent {

    public async chatLoop() {
        console.log("\n\x1b[93m[System]\x1b[0m Loading LLM Server via OpenAI SDK...");
        
        const state = new fileAgentState();
        const processId = crypto.randomUUID();
        state.processId = processId;
        fileAgentRecord[processId] = state;
        
        const llm = await LLMService.getInstance();

        console.log("\n\x1b[92m=== File Organization Agent Pipeline ===\x1b[0m");
        console.log("Pipeline starting. Stage 1: Planning...");
        console.log("Type 'exit' to quit.\n");

        // ==========================================
        // STAGE 1: Planning Agent
        // ==========================================
        console.log("\x1b[96m[Planning Agent Initialized]\x1b[0m");
        const agent1Prompt = planningAgentSystemPrompt(processId);
        const session1 = new OpenAISession(llm, agent1Prompt);
        while (process.stdin.read() !== null) {
            // Keep looping until the stream buffer is entirely empty
        }
        const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
        const userInput = await rl.question("\x1b[94mUser:\x1b[0m ");
            rl.close();

        if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') return;

        // Seed or start the planning agent
        let result1 = await session1.prompt(userInput, {
            functions: PlanningTools
        });

        while (true) {
            if (result1?.includes(HANDOFF_CATEGORIZATION_SENTINEL)) {
                break;
            }

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const userInput = await rl.question("\x1b[94mUser (Planning):\x1b[0m ");
            rl.close();

            if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') return;

            result1 = await session1.prompt(userInput, {
                functions: PlanningTools
            });
        }

        // ==========================================
        // STAGE 2: Categorization Agent
        // ==========================================
        console.log("\n\x1b[96m[Categorization Agent Initialized]\x1b[0m");
        const agent2Prompt = categorizationAgentSystemPrompt(processId);
        const session2 = new OpenAISession(llm, agent2Prompt);

        // Seed stage 2 to begin executing the todo list immediately
        let result2 = await session2.prompt("Begin categorization.", {
            functions: CategorizationTools
        });

        while (true) {
            if (result2?.includes(HANDOFF_EXECUTION_SENTINEL)) {
                break;
            }

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            const userInput = await rl.question("\x1b[94mUser (Categorization):\x1b[0m ");
            rl.close();

            if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') return;

            result2 = await session2.prompt(userInput, {
                functions: CategorizationTools
            });
        }

        // ==========================================
        // STAGE 3: Execution Agent
        // ==========================================
        console.log("\n\x1b[96m[Execution Agent Initialized]\x1b[0m");
        const agent3Prompt = executionAgentSystemPrompt(processId);
        const session3 = new OpenAISession(llm, agent3Prompt);

        // Stage 3 executes in one shot by showing the plan and running execution tool
        await session3.prompt("Show the final plan for confirmation and then execute the process.", {
            functions: ExecutionTools
        });

        console.log("\n\x1b[92m=== File Organization Pipeline Completed Successfully ===\x1b[0m\n");
    }
}

export const fileAgent = new FileAgent();
fileAgent.chatLoop().catch(console.error);
