import { spawn } from 'child_process';
import * as path from 'path';

export class ClassificationUtility {
    
    /**
     * Takes an array of embeddings and uses a Python HDBSCAN script to cluster them.
     * Returns an array of cluster labels corresponding to each embedding.
     * A label of -1 indicates "noise" (no cluster).
     */
    public static async clusterEmbeddings(embeddings: number[][]): Promise<{ labels: number[], representatives: Record<string, number[]> }> {
        return new Promise((resolve, reject) => {
            if (!embeddings || embeddings.length === 0) {
                return resolve({ labels: [], representatives: {} });
            }

            const scriptPath = path.resolve(process.cwd(), 'scripts/cluster.py');
            const pythonExecutable = path.resolve(process.cwd(), '.venv/bin/python3');
            
            const pythonProcess = spawn(pythonExecutable, [scriptPath]);
            
            let outputData = '';
            let errorData = '';

            pythonProcess.stdout.on('data', (data) => {
                outputData += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                errorData += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Python clustering script failed (code ${code}): ${errorData}`));
                }
                try {
                    const result = JSON.parse(outputData);
                    if (result.error) {
                        return reject(new Error(`Clustering error: ${result.error}`));
                    }
                    if (Array.isArray(result)) {
                        // Backwards compatibility if python scripts returns array
                        resolve({ labels: result, representatives: {} });
                    } else {
                        resolve(result);
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse clustering output.\nPython code: ${code}\nStderr: ${errorData}\nStdout: ${outputData}`));
                }
            });

            // Prevent Node.js from crashing if the Python process immediately dies
            pythonProcess.stdin.on('error', (err) => {
                console.error("Failed to write to python process. It might have crashed on startup.", err);
            });

            // Send standard input
            const inputJson = JSON.stringify(embeddings);
            pythonProcess.stdin.write(inputJson);
            pythonProcess.stdin.end();
        });
    }
}