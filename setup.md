# TypeScript AI Agent Setup Guide

This guide covers how to set up the environment to run the autonomous File Organization AI Agent (`agent.ts`) directly via Node.js using ES Modules and `node-llama-cpp`. 

`node-llama-cpp` comes with pre-compiled bindings so it will automatically leverage your Mac's Apple Silicon (Metal API) GPU without needing custom installation flags.

## Setup Instructions

Run these terminal commands in order inside your project folder:

### 1. Initialize the Project
Initialize a new Node project and tell Node to treat your TS files as modern ES modules:
\`\`\`bash
npm init -y
npm pkg set type="module"
\`\`\`

### 2. Install Dependencies
Install the required packages. We use `tsx` instead of `ts-node` because `tsx` properly supports native ES Modules (which `node-llama-cpp` requires).
\`\`\`bash
npm install -D typescript @types/node tsx
npm install node-llama-cpp
\`\`\`

### 3. Configure TypeScript
Generate a modern TypeScript configuration (`tsconfig.json`) that targets modern environments:
\`\`\`bash
npx tsc --init --target es2022 --module es2022 --moduleResolution node16
\`\`\`

### 4. Run the Agent
Once the configuration is complete, run the agent using `tsx`:
\`\`\`bash
npx tsx agent.ts
\`\`\`

The model will automatically load `Qwen3.5-9B-Q5_K_M.gguf` from disk into your Mac's GPU memory, and the chat interface will appear.