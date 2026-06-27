import { LLMService } from './LLMService.js';
import {
    planningAgentSystemPrompt,
    categorizationAgentSystemPrompt,
    executionAgentSystemPrompt
} from './prompt/fileAgent.js';
import { fileAgentRecord, fileAgentState } from './state/fileAgentState.js';
import { OpenAISession } from './workerAgent.js';
import {
    ERROR_ENCOUNTERED,
    HANDOFF_CATEGORIZATION_SENTINEL,
    HANDOFF_EXECUTION_SENTINEL
} from '../tools/pipelineTools.js';
import { PlanningTools } from '../tools/planningAgentTools.js';
import { CategorizationTools } from '../tools/categorizationAgentTools.js';
import { ExecutionTools } from '../tools/executionAgentTools.js';
import { emitLog, emitStage } from '../electron/ipcBridge.js';

export class FileAgent {

    public async chatLoop(initialUserMessage: string): Promise<void> {
        emitLog('Loading LLM Server via OpenAI SDK...', 'info');
        
        const state = new fileAgentState();
        const processId = crypto.randomUUID();
        state.processId = processId;
        fileAgentRecord[processId] = state;
        let errorEncountered: boolean = false;
        const llm = await LLMService.getInstance();

        emitLog('File Organization Agent Pipeline starting. Stage 1: Planning...', 'pipeline');

        // ==========================================
        // STAGE 1: Planning Agent
        // ==========================================
        emitStage('planning');
        emitLog('Planning Agent Initialized', 'pipeline');
        const agent1Prompt = planningAgentSystemPrompt(processId);
        const session1 = new OpenAISession(llm, agent1Prompt);

        if (initialUserMessage.toLowerCase() === 'exit' || initialUserMessage.toLowerCase() === 'quit') return;

        // Seed the planning agent with the user's initial message
        let result1 = await session1.prompt(initialUserMessage, {
            functions: PlanningTools,
            forceToolUse: true
        });

        const MAX_AUTO_CONTINUE = 5;
        let autoContinueCount1 = 0;
        while (true) {
            if (result1?.includes(HANDOFF_CATEGORIZATION_SENTINEL)) {
                break;
            }
            if (result1?.includes(ERROR_ENCOUNTERED)) {
                errorEncountered = true;
                break;
            }
            if (++autoContinueCount1 > MAX_AUTO_CONTINUE) {
                emitLog('Planning Agent stalled without handing off — aborting.', 'error');
                errorEncountered = true;
                break;
            }

            result1 = await session1.prompt('Continue with the next step.', {
                functions: PlanningTools,
                forceToolUse: true
            });
        }
        if (errorEncountered) return;

        // ==========================================
        // STAGE 2: Categorization Agent
        // ==========================================
        emitStage('categorization');
        emitLog('Categorization Agent Initialized', 'pipeline');
        const agent2Prompt = categorizationAgentSystemPrompt(processId);
        const session2 = new OpenAISession(llm, agent2Prompt);

        // Seed stage 2 to begin executing the todo list immediately
        let result2 = await session2.prompt('Begin categorization.', {
            functions: CategorizationTools,
            forceToolUse: true
        });

        let autoContinueCount2 = 0;
        while (true) {
            if (result2?.includes(HANDOFF_EXECUTION_SENTINEL)) {
                break;
            }
            if (result2?.includes(ERROR_ENCOUNTERED)) {
                errorEncountered = true;
                break;
            }
            if (++autoContinueCount2 > MAX_AUTO_CONTINUE) {
                emitLog('Categorization Agent stalled without handing off — aborting.', 'error');
                errorEncountered = true;
                break;
            }

            result2 = await session2.prompt('Continue with the next step.', {
                functions: CategorizationTools,
                forceToolUse: true
            });
        }
        if (errorEncountered) return;

        // ==========================================
        // STAGE 3: Execution Agent
        // ==========================================
        emitStage('execution');
        emitLog('Execution Agent Initialized', 'pipeline');
        const agent3Prompt = executionAgentSystemPrompt(processId);
        const session3 = new OpenAISession(llm, agent3Prompt);

        // Stage 3 executes in one shot by showing the plan and running execution tool
        await session3.prompt('Show the final plan for confirmation and then execute the process.', {
            functions: ExecutionTools
        });

        emitLog('File Organization Pipeline Completed Successfully', 'pipeline');
    }
}

export const fileAgent = new FileAgent();
