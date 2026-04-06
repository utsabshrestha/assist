import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { defineChatSessionFunction, getLlama, type GbnfJsonStringSchema } from 'node-llama-cpp';
import { LLMService } from '../src/LLMService.js';
import { fileAnalyzerWorkerAgentPrompt } from '../src/prompt/fileAgent.js';



export const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/__pycache__/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/vendor/**",
  "**/bin/**",
  "**/obj/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/.zig-cache/**",
  "**/zig-out/**",
  "**/.coverage",
  "**/coverage/**",
  "**/tmp/**",
  "**/temp/**",
  "**/.cache/**",
  "**/cache/**",
  "**/logs/**",
  "**/.venv/**",
  "**/venv/**",
  "**/env/**",
  "**/.DS_Store" // Recommended for Mac users
];

const MAX_DEPTH = 5; // Prevent "terrible" deep nesting
const MAX_FILES = 200; // Safety cap for the LLM

async function getFilesListInAFolder(dir: string): Promise<string[]> {
    let allFiles: string[] = [];

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        const sortedFiles = entries
        // 1. Filter out directories, keeping only files
        .filter(entry => entry.isFile())
        // 2. Sort the files alphabetically by name
        .sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of sortedFiles) {
            const fullPath = path.join(dir, entry.name);

            // Get file stats for metadata
            try {
                const stats = await fs.stat(fullPath);
                const prefix = entry.isDirectory() ? "[DIR]" : "[FILE]";
                
                let fileInfo = `${prefix} ${fullPath}`;
                
                // Add file size
                const sizeInKB = (stats.size / 1024).toFixed(2);
                fileInfo += ` | Size: ${sizeInKB} KB`;
                
                // Add file type (extension)
                const ext = path.extname(fullPath) || "no extension";
                fileInfo += ` | Type: ${ext}`;
                
                // Add creation date
                const createdDate = new Date(stats.birthtime).toLocaleString();
                fileInfo += ` | Created: ${createdDate}`;

                // Add modified date
                const modifiedDate = new Date(stats.mtime).toLocaleString();
                fileInfo += ` | Modified: ${modifiedDate}`;

                allFiles.push(fileInfo);
            } catch (err) {
                // Fallback if stat fails
                const prefix = entry.isDirectory() ? "[DIR]" : "[FILE]";
                allFiles.push(`${prefix} ${fullPath}`);
            }
        }
    } catch (err) {
        // Handle permission denied or missing folders silently
        console.error(`Could not read ${dir}:`, err);
    }
    return allFiles;
}

async function getFilesRecursive(
    dir: string,
    currentDepth = 0,
    allFiles: string[] = [],
    LookRecursivelyInFolder: boolean
): Promise<string[]> {
    // 1. Exit if we hit safety limits
    if (currentDepth > MAX_DEPTH || allFiles.length >= MAX_FILES) {
        return allFiles;
    }

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        // Sort: Files first, then Directories. Alphabetical within each group.
        entries.sort((a, b) => {
        // If one is a file and the other is a directory, prioritize the file
        if (a.isFile() && b.isDirectory()) return -1;
        if (a.isDirectory() && b.isFile()) return 1;

        // Otherwise, sort alphabetically by name
        return a.name.localeCompare(b.name);
        });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            // 2. Ignore Logic: Check if the path matches any patterns
            const isIgnored = IGNORE_PATTERNS.some(pattern =>
                minimatch(fullPath, pattern, { dot: true })
            );

            if (isIgnored) continue;

            // Get file stats for metadata
            try {
                const stats = await fs.stat(fullPath);
                const prefix = entry.isDirectory() ? "[DIR]" : "[FILE]";
                
                let fileInfo = `${prefix} ${fullPath}`;
                
                if (!entry.isDirectory()) {
                    // Add file size
                    const sizeInKB = (stats.size / 1024).toFixed(2);
                    fileInfo += ` | Size: ${sizeInKB} KB`;
                    
                    // Add file type (extension)
                    const ext = path.extname(fullPath) || "no extension";
                    fileInfo += ` | Type: ${ext}`;
                    
                    // Add creation date
                    const createdDate = new Date(stats.birthtime).toLocaleString();
                    fileInfo += ` | Created: ${createdDate}`;
                } else {
                    // For directories, just show the modified date
                    const modifiedDate = new Date(stats.mtime).toLocaleString();
                    fileInfo += ` | Modified: ${modifiedDate}`;
                }
                
                allFiles.push(fileInfo);
            } catch (err) {
                // Fallback if stat fails
                const prefix = entry.isDirectory() ? "[DIR]" : "[FILE]";
                allFiles.push(`${prefix} ${fullPath}`);
            }

            if (entry.isDirectory() && LookRecursivelyInFolder) {
                await getFilesRecursive(fullPath, currentDepth + 1, allFiles, LookRecursivelyInFolder);
            } 
            if (allFiles.length >= MAX_FILES) break;
        }
    } catch (err) {
        // Handle permission denied or missing folders silently
        console.error(`Could not read ${dir}:`, err);
    }

    return allFiles;
}



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
        description: "This tool will provide the summary of the types of files in the current directory.",
        params: {
            type: "object",
            properties: {
                path: {
                    type: "string"
                }
            }
        },
        async handler(params): Promise<string> {
            const targetPath = params.path.toLowerCase();
            console.log(`\x1b[95m[Worker Agent Action]\x1b[0m Reading files in directory: ${targetPath}`);
            try {
                let output = await getFilesListInAFolder(params.path);
                if (output.length > 0){
                    const fileInformation = `Total files discovered in the folder : ${output.length} \n` + output.join("\n");
                    const llm = await LLMService.getInstance();
                    const llmSession = (await llm.createSession(fileAnalyzerWorkerAgentPrompt));
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
                    
                    //Instruct (or non-thinking) mode for general tasks: temperature=0.7, top_p=0.8, top_k=20, min_p=0.0, presence_penalty=1.5, repetition_penalty=1.0
                    const reply = await llmSession.prompt(fileInformation, {
                        temperature: 0.7,
                        topP:0.8,
                        topK: 20,
                        minP: 0.0,
                        grammar: grammarForFileAnalyzer
                    });

                    const parsedResponse = grammarForFileAnalyzer.parse(reply);
                    const masterSummary = buildMasterSummary(parsedResponse);
                    console.log(llm.checkGlobalContextStatus());
                    console.log(llm.checkContextUsage(llmSession));
                    llm.endSession(llmSession);
                    console.log(llm.checkGlobalContextStatus());
                    return masterSummary;
                }
                return `There are no files in the given directory "${targetPath}"`;
            } catch (e: any) {
                return `Error reading directory '${targetPath}': ${e.message}`;
            }
        }
    }),
    createFolder: defineChatSessionFunction({
        description: "This tool allows you to create folders for the given list of paths. Important : Before calling this function you have to ask permission with the user then only you can operate this.",
        params:{
            type: "array",
            items: {
                type: "string",
                description: "The full path of the folder you want to be created."
            },
            description: "A List of folder paths to be created.",
        },
        async handler(params): Promise<string[]> {
            const folderList  = params;
            let response : string[] = [];
            for(const folderName in folderList){
                const targetPath = folderName.toLowerCase();
                try {
                    await fs.mkdir(targetPath, { recursive: true });
                    response.push(`Status : Success | Folder is created for path '${targetPath}'`)
                } catch (e: any) {
                    response.push(`Status : Failed | Folder could not be created for path '${targetPath}'`)
                }
            }
            return response;   
        }

    }),
    executeMovePlan: defineChatSessionFunction({
        description: "This tool allows you to move multiple files from source to destination at once by passing the list of object with source and destination. Important : Before calling this function you have to ask permission with the user then only you can operate this.",
        params:{
            type: "array",
            description: "The function accepts a list of object with properties source and destination for the files to be move from source to destination.",
            items: {
                type: "object",
                properties: {
                    source: {
                        type: "string",
                        description: "The source properties should have the current location of the file."
                    },
                    destination: {
                        type: "string",
                        description: "The destination properties should have the new destination where the file is meant to be moved."
                    }
                }
            },
            required: ["source", "destination"]
        },
        async handler (params): Promise<string[]> {
            const moveOperationList = params as any[];
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
            return response;
        }
    })
};