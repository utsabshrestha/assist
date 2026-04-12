import { defineChatSessionFunction, getLlama, type GbnfJsonStringSchema } from 'node-llama-cpp';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileAgentRecord, fileAgentState } from '../src/state/fileAgentState.js';

const fileTools = {
    analyzeFolder : defineChatSessionFunction({
        description: "This tool provides the number of files and unique file extensions present in the folder.",
        params: {
            type: "object",
            properties:{
                "path":{
                    type: "string",
                    "description": "The path of the location."
                },
                "ProcessId":{
                    type: "string",
                    "description": "The unique process id to maintain the agent state."
                }
            }
        }, 
        async handler(params): Promise<string>{
            const entries = await fs.readdir(params.path, { withFileTypes: true });
            let state = fileAgentRecord[params.ProcessId];
            if( state != undefined ){
                const sortedFiles = entries
                // 1. Filter out directories, keeping only files
                .filter(entry => entry.isFile())
                // 2. Sort the files alphabetically by name
                .sort((a, b) => a.name.localeCompare(b.name));

                const files : string[] = sortedFiles.map(file => file.name);
                const extensions = Array.from(new Set(files.map(name => path.extname(name).toLowerCase()).filter(ext => ext !== '')));
                fileState.fileList = files;

                state.filesCount = sortedFiles.length;
                state.extensions = extensions;
                state.fileList = sortedFiles;

                const dirInfo = {
                    fileCount: sortedFiles.length,
                    extensions: extensions.join(" ,")
                };
                
                return JSON.stringify(dirInfo); 
            }else{
                return "The process id is not correct.";
            }
        }
    }),
    analyzeFiles : defineChatSessionFunction({
        description: "This tool provides the list of files name present in the folder iteratively.",
        params: {
            type: "object",
            properties:{
                path: {
                    type: "string",
                    description: "The path of the folder."
                },
                ProcessId: {
                    type: "number",
                    description: "The unique process id to maintain the agent state."
                }
            }
        }, async handler(params): Promise<string> {
            let state = fileAgentRecord[params.ProcessId];
            if ( state != undefined){
                let files = state.fileList.slice(state.lastReadInd, 50);
                state.lastReadInd += 50;
                if (files.length  > 0){
                    return files.join(" \n ");
                }else{
                    return "No files left to read."
                }
            }else{
                return "The process id is not correct.";
            }
        }
    })
}