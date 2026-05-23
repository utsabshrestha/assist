import * as fs from 'fs/promises';
import * as path from 'path';

export class FileContentExtractor {
    /**
     * Extracts a snippet of text from the given file, capped at around 1000 chars.
     */
    public static async extractContent(filePath: string): Promise<string> {
        const ext = path.extname(filePath).toLowerCase();
        const baseName = path.basename(filePath);
        let content = '';

        try {
            if (ext === '.pdf') {
                const pdfParseM = await import('pdf-parse/lib/pdf-parse.js');
                // @ts-ignore
                const pdfParse = pdfParseM.default || pdfParseM;
                const dataBuffer = await fs.readFile(filePath);
                const data = await pdfParse(dataBuffer, { max: 10 }); // First 2 pages approx
                content = data.text || '';
            } else if (ext === '.docx' || ext === '.doc') {
                const mammothM = await import('mammoth');
                const mammoth = mammothM.default || mammothM;
                try {
                    const result = await mammoth.extractRawText({ path: filePath });
                    content = result.value || '';
                } catch (mammothErr: any) {
                    if (mammothErr.message?.includes("Can't find end of central directory")) {
                        // This usually happens with orphaned Office lock files (like ~$filename.docx) or corrupted files.
                        // We safely ignore it and return empty content instead of crashing or logging an ugly error.
                        content = '';
                    } else {
                        throw mammothErr;
                    }
                }
            } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
                const xlsxM = await import('xlsx');
                const xlsx = xlsxM.default || xlsxM;
                const workbook = xlsx.readFile(filePath);
                const sheets = workbook.SheetNames;
                content += `Sheets: ${sheets.join(', ')}\n`;
                if (sheets.length > 0) {
                    const firstSheet = workbook.Sheets[sheets[0]];
                    const json = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });
                    if (json.length > 0) {
                        content += `Headers/Row1: ${JSON.stringify(json[0])}\n`;
                    }
                }
            } else if (ext === '.pptx' || ext === '.ppt') {
                const officeParserM = await import('officeparser');
                const officeParser = officeParserM.default || officeParserM;
                // parseOffice is async
                content = await officeParser.parseOffice(filePath);
            } else if (ext === '.txt' || ext === '.md' || ext === '.json') {
                // Read only the first 2048 bytes to save memory (preventing huge memory spikes on large logs/json)
                const fd = await fs.open(filePath, 'r');
                try {
                    const buffer = Buffer.alloc(2048);
                    const { bytesRead } = await fd.read(buffer, 0, 2048, 0);
                    content = buffer.toString('utf-8', 0, bytesRead);
                } finally {
                    await fd.close();
                }
            }
        } catch (e) {
            console.error(`Failed to extract content for ${filePath}: ${e}`);
        }

        // Clean up and truncate
        content = content.replace(/\s+/g, ' ').trim();
        if (content.length > 1000) {
            content = content.substring(0, 1000) + '...';
        }

        return `Title: ${baseName}\n\nSnippet: ${content}`;
    }
}

