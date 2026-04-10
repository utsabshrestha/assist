import * as fs from 'fs/promises';
import * as path from 'path';

class fileUtility{

     readonly  IGNORE_PATTERNS = [
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

    readonly MAX_DEPTH = 5; // Prevent "terrible" deep nesting
    readonly MAX_FILES = 200; // Safety cap for the LLM

    public ValidatePaths(actualPath : string, pathToVerify : string[]){
        // Resolve the actual path to an absolute path for safety
        const resolvedActualPath = path.resolve(actualPath);

        const invalidFolders = pathToVerify.filter(folder => {
            // Resolve each folder path
            const resolvedFolder = path.resolve(folder);
            
            // Get the relative path from the actualPath to the folder
            const relative = path.relative(resolvedActualPath, resolvedFolder);
            
            // If the relative path starts with '..', or is an absolute path (handles diff drives on Windows),
            // it means the folder is OUTSIDE of acutalPath.
            const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
            
            return isOutside;
        });

        if (invalidFolders.length > 0) {
            throw new Error(`The following folders are outside the allowed directory: ${invalidFolders.join(", ")}`);
        }
    }

    public async getFilesListInAFolder(dir: string): Promise<string[]> {
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
                    //const prefix = entry.isDirectory() ? "[DIR]" : "[FILE]";
                    
                    // let fileInfo = `${prefix} ${fullPath}`;
                    let fileInfo = `${entry.name}`;
                    
                    // Add file size
                    const sizeInKB = (stats.size / 1024).toFixed(2);
                    fileInfo += ` | Size: ${sizeInKB} KB`;
                    
                    // Add file type (extension)
                    const ext = path.extname(fullPath) || "no extension";
                    fileInfo += ` | Type: ${ext}`;
                    
                    // Add creation date
                    //const createdDate = new Date(stats.birthtime).toLocaleString();
                    //fileInfo += ` | Created: ${createdDate}`;
    
                    // Add modified date
                    //const modifiedDate = new Date(stats.mtime).toLocaleString();
                    //fileInfo += ` | Modified: ${modifiedDate}`;
    
                    allFiles.push(fileInfo);
                } catch (err) {
                    // Fallback if stat fails
                    const prefix = entry.isDirectory() ? "[DIR]" : "[FILE]";
                    // allFiles.push(`${prefix} ${fullPath}`);
                    allFiles.push(`${entry.name}`);
                }
            }
        } catch (err) {
            // Handle permission denied or missing folders silently
            console.error(`Could not read ${dir}:`, err);
        }
        return allFiles;
    }
    
    public async getFilesRecursive(
        dir: string,
        currentDepth = 0,
        allFiles: string[] = [],
        LookRecursivelyInFolder: boolean
    ): Promise<string[]> {
        // 1. Exit if we hit safety limits
        if (currentDepth > this.MAX_DEPTH || allFiles.length >= this.MAX_FILES) {
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
                const isIgnored = this.IGNORE_PATTERNS.some(pattern =>
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
                    await this.getFilesRecursive(fullPath, currentDepth + 1, allFiles, LookRecursivelyInFolder);
                } 
                if (allFiles.length >= this.MAX_FILES) break;
            }
        } catch (err) {
            // Handle permission denied or missing folders silently
            console.error(`Could not read ${dir}:`, err);
        }
    
        return allFiles;
    }

    public ChunkArray<T>(array: T[], size: number) : T[][] {
        const chunked : T[][] = [];
        for(let i = 0; i < array.length; i+= size){
            chunked.push(array.slice(i, i + size));
        }
        return chunked;
    }
}

export const fileUtil = new fileUtility()