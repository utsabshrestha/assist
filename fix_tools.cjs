const fs = require('fs');

function transformFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Remove import of defineChatSessionFunction
    content = content.replace(/import \{.*defineChatSessionFunction.*\} from 'node-llama-cpp';/g, '');
    
    // Replace const ToolName = defineChatSessionFunction({
    content = content.replace(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*defineChatSessionFunction\(\{([\s\S]*?)description:\s*(".*?"|`.*?`),([\s\S]*?)params:\s*(\{[\s\S]*?\}),([\s\S]*?async\s*handler\s*\([\s\S]*?\)\s*\{)/g, (match, name, p1, desc, p2, params, rest) => {
        return `export const ${name} = {\n    type: "function",\n    function: {\n        name: "${name}",\n        description: ${desc},\n        parameters: ${params}\n    },${rest}`;
    });

    // We have to close the brace at the end of the tool manually if defineChatSessionFunction was closed.
    // Actually defineChatSessionFunction({ ... }) ends with `});`. 
    content = content.replace(/\}\);\n/g, '};\n');

    fs.writeFileSync(filePath, content);
}

transformFile('tools/fileOrgTool.ts');
transformFile('tools/fileOrgWorkerTool.ts');
