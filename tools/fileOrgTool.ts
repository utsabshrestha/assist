import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { defineChatSessionFunction, getLlama, type GbnfJsonStringSchema } from 'node-llama-cpp';
import { LLMService } from '../src/LLMService.js';
import { fileAnalyzerWorkerAgentPrompt, fileMoverWorkerAgentSystemPrompt, fileMoverWorkerAgentUserPrompt } from '../src/prompt/fileAgent.js';
import { fileAgent } from '../src/agent.js';
import { fileUtil } from '../src/utils/fileUtility.js';
import { workerAgent } from './workerAgent.js';

const maxFileToRead = 250;

const FLAG_DESCRIPTIONS: Record<string, string> = {
  "dupes":  "duplicate filenames detected",
  "no-ext": "files with no extension found",
  "deep":   "folder nesting deeper than 3 levels",
  "large":  "files over 100MB present",
  "hidden": "hidden dotfiles present",
  "empty":  "empty subfolders exist"
};

function buildMasterSummary(workerJson: any): string {
  // Decode flags into human readable text
  const flagList = workerJson.flags
    ? workerJson.flags.split("|").map(f => FLAG_DESCRIPTIONS[f] ?? f)
    : [];

  // Decode fileGroups into readable lines
  const groupLines = workerJson.fileGroups
    .map(g => `  - ${g.category}: ${g.count} files (${g.extensions}) e.g. "${g.sample}"`)
    .join("\n");

  // Build a clean natural language summary for master
    return `
    Folder: ${workerJson.path}
    Total: ${workerJson.totalFiles} files, ${workerJson.totalMB}MB

    File breakdown:
    ${groupLines}

    ${flagList.length > 0 ? `Issues found:\n${flagList.map(f => `  - ${f}`).join("\n")}` : "No issues found."}
    `.trim();
}

export const tools = {
    analyzeFolder: defineChatSessionFunction({
        description: "This is your worker agent which will investigates all the files in the provided location. You have to call this function only once, because if there are lot of files it will take time to get respond.",
        params: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path of the folder where you want to investigate."
                }
            }
        },
        async handler(params): Promise<string> {
            const targetPath = params.path.toLowerCase();
            console.log(`\x1b[95m[Worker Agent Action]\x1b[0m Reading files in directory: ${targetPath}`);
            try {
                let output = await fileUtil.getFilesListInAFolder(params.path);
                if (output.length > 0){
                    const llm = await LLMService.getInstance();
                    const grammarForFileAnalyzer = await llm.llama.createGrammarForJsonSchema({
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        totalFiles: { type: "integer" },
                        totalMB: { type: "number" },             // number instead of "128 MB" string
                        fileGroups: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                            category: { type: "string" },      // readable
                            count: { type: "integer" },        // readable
                            extensions: { type: "string" },    // "jpg,png,heic" joined — big saving
                            sample: { type: "string" }         // ONE filename, not an array
                            },
                            required: ["category", "count", "extensions", "sample"]
                        }
                        },
                        flags: { type: "string" }                // "dupes|no-ext" joined — readable enough
                    },
                    required: ["status", "error", "path", "totalFiles", "totalMB", "fileGroups", "flags"]
                    });
                    let fileInformation : string = `FOLDER Path : ${targetPath} \n Total files discovered in the folder : ${output.length} \n`;
                    if (output.length <= maxFileToRead){
                        // output = output.slice(0, 50);
                        fileInformation += output.join("\n");
                        let response = await workerAgent.getWorkerAgent<any>(fileAnalyzerWorkerAgentPrompt, fileInformation, grammarForFileAnalyzer, "file_Analyzer");
                        return buildMasterSummary(response);
                    }else{

                        const chunkFileArray = fileUtil.ChunkArray(output, maxFileToRead);
                        
                        // const response = await Promise.all(
                        //     chunkFileArray.map((chunks,ind) => workerAgent.getWorkerAgent<any>(fileAnalyzerWorkerAgentPrompt, chunks.join("\n"), grammarForFileAnalyzer, `file_Analyzer_${ind}`))
                        // );

                        // const overallResp = response.map(resp => buildMasterSummary(resp)).join("\n\n");
                        // return overallResp;

                        let overallRespArray: string[] = [];
                        for (let ind = 0; ind < chunkFileArray.length; ind++) {
                            const chunks  = chunkFileArray[ind];
                            if (chunks != undefined &&  chunks.length > 0){
                                fileInformation += `You are given only ${chunks.length} files to analyze. \n` + chunks.join("\n");
                                const resp = await workerAgent.getWorkerAgent<any>(fileAnalyzerWorkerAgentPrompt, fileInformation, grammarForFileAnalyzer, `file_Analyzer_${ind}`);
                                let response = `Worker Agent ${ind} Analysis of ${chunks.length} files. \n` + buildMasterSummary(resp);
                                overallRespArray.push(response);
                            }
                        }
                        let overralRespond = `We had total ${output.length} files in our directory : ${targetPath}. So our Agent decided to run muliple Worker Agent to analyze these files. Below is the analysis of each chunk of size ${maxFileToRead} by ${chunkFileArray.length} Worker Agent. \n\n`;
                        return overralRespond + overallRespArray.join("\n\n");
                    }
                }
                return `There are no files in the given directory "${targetPath}"`;
            } catch (e: any) {
                return `Error reading directory '${targetPath}': ${e.message}`;
            }
        }
    }),
    createFolder: defineChatSessionFunction({
        description: "This tool allows you to create folders for the given list of absolute paths.",
        params:{
            type: "array",
            items: {
                type: "string",
                description: "The absolute path of the folder you want to create."
            },
            description: "A List of folder paths to be created.",
        },
        async handler(params): Promise<string> {
            const folderList  = params;
            let response : string[] = [];
            for(const folderName of folderList){
                const targetPath = folderName.toLowerCase();
                try {
                    await fs.mkdir(targetPath, { recursive: true });
                    response.push(`Status : Success | Folder Created '${targetPath}'`)
                } catch (e: any) {
                    response.push(`Status : Failed | Folder Not Created '${targetPath}'`)
                }
            }
            return response.join("\n");
        }

    }),
    executeMovePlan: defineChatSessionFunction({
        description: "This is a worker agent which will move the files to the newly created folders as per your instruction.",
        params:{
            type: "object",
            properties: {
                instruction: {
                    type: "string",
                    description: "Please provide the clear instruction to the worker agent, how the files should be analyzed and categorized based on the planning and confirmation you have with the USER.",
                },
                folders:{
                    type: "string",
                    description: "Please provide the absolute path of newly created folder concatenated with the '|'."
                }
            }
        },
        async handler (params): Promise<string> {
            const actualPath = fileAgent.path;
            let folders = params.folders.split("|");
            fileUtil.ValidatePaths(actualPath, folders);
            let files = await fileUtil.getFilesListInAFolder(actualPath);
            if (files.length > 0){
                let folderList: string = folders.map(x => `- ${x}`).join('\n');

                const fileInformation = `Total files discovered in the folder : ${files.length} \n` + files.join("\n");                
                const llm = await LLMService.getInstance();
                console.log(llm.getGlobalContextUsage(llm.context));

                const llmSession = await llm.createSession(fileMoverWorkerAgentSystemPrompt);

                const grammarFileMove = await llm.llama.createGrammarForJsonSchema({
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            source: { type: "string" },
                            destination: { type: "string" },
                        },
                        required: ["source", "destination"]
                    }
                });
                
                const instructionPrompt = fileMoverWorkerAgentUserPrompt(params.instruction, folderList, fileInformation);
                const reply = await llmSession.prompt(instructionPrompt, {
                            temperature: 0.7,
                            topP:0.8,
                            topK: 20,
                            minP: 0.0,
                            grammar: grammarFileMove
                        });
    
                const parsedResponse = grammarFileMove.parse(reply);
                console.log(llm.getGlobalContextUsage(llm.context));
                console.log(llm.getSessionContextUsage(llmSession));
                llm.endSession(llmSession);
                console.log(llm.getGlobalContextUsage(llm.context));

                const moveOperationList = parsedResponse;
                let response : string[] = []
                for (const fileInfo of moveOperationList) {
                    try {
                        const destDir = path.dirname(fileInfo.destination);
                        await fs.mkdir(destDir, { recursive: true });
                        
                        await fs.rename(fileInfo.source, fileInfo.destination);
                        response.push(`Status : Success: Moved '${fileInfo.source}' to '${fileInfo.destination}'.`);
                    } catch (e: any) {
                        response.push(`Status : Failed: Could not move '${fileInfo.source}' to '${fileInfo.destination}'.`);
                    }
                }
            }

            return '';
        }
    })
};