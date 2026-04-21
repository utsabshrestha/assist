import * as fs from 'fs/promises';
import * as path from 'path';
import { defineChatSessionFunction } from 'node-llama-cpp';
import { fileAgentRecord, fileStatus } from '../src/state/fileAgentState.js';
import { fileUtil } from '../src/utils/fileUtility.js';

const checkFolder = defineChatSessionFunction({
    description: "Call this FIRST, ONCE. Returns the total file count and unique extensions in the workspace folder. Does NOT return file names — call getNextFileBatch to retrieve files in batches.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            }
        },
        required: ["ProcessId"]
    },
    async handler(params): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        if (!state.workspacePath) return "Error: workspacePath not set in state.";

        try {
            const entries = await fs.readdir(state.workspacePath, { withFileTypes: true });
            const files = entries
                .filter((e: fs.Dirent) => e.isFile())
                .sort((a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name));
            let totalFileSize : number = 0;

            await Promise.all(files.map(async (file: fs.Dirent) => {
                const fullPath = path.join(state.workspacePath, file.name);
                try {
                    const stats = await fs.stat(fullPath);
                    const sizeKB = parseFloat((stats.size / 1024).toFixed(2));
                    totalFileSize += sizeKB;
                    const ext = path.extname(file.name) || "no extension";
                    state.AddFile(new fileStatus(file.name, fullPath, false, sizeKB, ext));
                } catch(ex) {
                    console.log(`Error encountered while listing files ${ex}`)
                }
            }));

            const extensions: string[] = Array.from(new Set(
                files.map((f: fs.Dirent) => path.extname(f.name).toLowerCase()).filter((e: string) => e !== '')
            ));

            state.filesCount = files.length;
            state.extensions = extensions;
            state.lastReadInd = 0;
            
            return JSON.stringify({
                fileCount: files.length,
                TotalFileSize: `${(totalFileSize / 1024).toFixed(2)} MB`,
                extensions: extensions.join(", "),
                message: "Call getNextFileBatch to retrieve file names in batches of 50."
            });
        } catch (e: any) {
            return `Error reading folder: ${e.message}`;
        }
    }
});

const getNextFileBatch = defineChatSessionFunction({
    description: "Returns the next batch of up to 50 file names from the workspace. Call repeatedly until the response contains 'done: true' to process all files incrementally.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            }
        },
        required: ["ProcessId"]
    },
    async handler(params): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        if (state.fileListData.length === 0) return "Error: No file list loaded. Call checkFolder first.";
        const fileList = state.fileListData.filter(file => file.status == false);

        const batch = fileList.slice(state.lastReadInd, state.lastReadInd + 50);
        if (batch.length === 0) return "No more files. All files have been processed.";

        const fileInfo = batch.map( val =>  `${val.fileName} | Size: ${val.fileSize} KB | Type: ${val.ext}`)

        state.lastReadInd += batch.length;
        const remaining = state.filesCount - state.lastReadInd;

        return JSON.stringify({
            files: fileInfo,
            batchSize: batch.length,
            processedSoFar: state.lastReadInd,
            remaining: remaining,
            done: remaining <= 0
        });
    }
});

const moveFile = defineChatSessionFunction({
    description: "Moves a single file from source to destination. Both paths must be within the workspace. The destination folder must already exist — this tool cannot create folders. Call this once per file.",
    params: {
        type: "object",
        properties: {
            ProcessId: {
                type: "string",
                description: "The unique process id for this session."
            },
            source: {
                type: "string",
                description: "Absolute path of the file to move."
            },
            destination: {
                type: "string",
                description: "Absolute destination path including the filename."
            }
        },
        required: ["ProcessId", "source", "destination"]
    },
    async handler(params): Promise<string> {
        const state = fileAgentRecord[params.ProcessId];
        if (!state) return "Error: Invalid ProcessId.";
        const fileName = path.basename(params.source);

        try {
            fileUtil.ValidatePaths(state.workspacePath, [params.source, params.destination]);
        } catch (e: any) {
            return `Error: Path boundary violation — ${e.message}`;
        }

        const destDir = path.dirname(params.destination);
        try {
            await fs.access(destDir);
        } catch {
            return `Error: Destination folder does not exist: '${destDir}'. Folders must be created by the master agent before calling moveFile.`;
        }

        try {
            await fs.rename(params.source, params.destination);
            if(state.fileRecord[fileName] != undefined){
                state.fileRecord[fileName].status = true;
            }
            return `OK: Moved '${path.basename(params.source)}' → '${destDir}'`;
        } catch (e: any) {
            return `Error: Could not move file — ${e.message}`;
        }
    }
});

export const analysisWorkerTools = { checkFolder, getNextFileBatch };
export const moveWorkerTools = { getNextFileBatch, moveFile };
