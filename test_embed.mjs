import { getLlama } from 'node-llama-cpp';
import path from 'path';

async function run() {
    console.log("Loading LLaMA...");
    const llama = await getLlama();
    const modelPath = path.resolve(process.cwd(), "nomic-embed-text-v1.5.Q6_K.gguf");
    const model = await llama.loadModel({ modelPath });
    const context = await model.createEmbeddingContext();
    const embedding = await context.getEmbeddingFor("search_document: Hello world");
    console.log("Embedding length:", embedding.vector.length);
}
run().catch(console.error);
