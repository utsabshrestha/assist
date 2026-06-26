import { off } from 'cluster';
import * as fs from 'fs/promises';
import type { OfficeParserAST } from 'officeparser';
import * as path from 'path';

export class FileContentExtractor {
    private static extractTextFromParsedObject(obj: any): string {
        if (typeof obj === 'string') return obj;
        if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
        if (obj === null || obj === undefined) return '';
        if (Array.isArray(obj)) {
            return obj.map(FileContentExtractor.extractTextFromParsedObject).join(' ');
        }
        if (typeof obj === 'object') {
            return Object.values(obj).map(FileContentExtractor.extractTextFromParsedObject).join(' ');
        }
        return '';
    }

    /**
     * Extracts a snippet of text from the given file, capped at around 600 chars.
     * Filename and content are returned separately so callers can choose whether
     * to embed/display them together or independently.
     */
    public static async extractContent(filePath: string): Promise<{ baseName: string; snippet: string }> {
        const ext = path.extname(filePath).toLowerCase();
        const baseName = path.basename(filePath);
        let content = '';
        let officeParseAst : OfficeParserAST = null;

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
                    if (json.length > 1) {
                        content += `SampleRows: ${JSON.stringify(json.slice(1, 6))}\n`;
                    }
                }
            } else if (ext === '.pptx' || ext === '.ppt') {
                const officeParserM = await import('officeparser');
                const officeParser = officeParserM.default || officeParserM;
                // parseOffice is async
                officeParseAst = await officeParser.parseOffice(filePath);
            } else if (ext === '.epub') {
                const { EPub } = await import('epub2');
                const epub = new EPub(filePath);
                await new Promise<void>((resolve, reject) => {
                    epub.on('end', () => resolve());
                    epub.on('error', (err) => reject(err));
                    epub.parse();
                });
                
                if (epub.flow && epub.flow.length > 0) {
                    const firstChapter = epub.flow[0];
                    if (firstChapter && firstChapter.id) {
                        const rawText = await new Promise<string>((resolve, reject) => {
                            epub.getChapter(firstChapter.id, (err, text) => {
                                if (err) reject(err);
                                else resolve(text);
                            });
                        });
                        content = rawText.replace(/<[^>]*>/g, ' ');
                    }
                }
            } else if (ext === '.html' || ext === '.htm' || ext === '.xml') {
                // HTML/XML is markup-heavy, so a larger window is needed to reach real content
                // past head/meta/script/style boilerplate that gets stripped anyway.
                const fd = await fs.open(filePath, 'r');
                try {
                    const buffer = Buffer.alloc(16384);
                    const { bytesRead } = await fd.read(buffer, 0, 16384, 0);
                    let rawText = buffer.toString('utf-8', 0, bytesRead);
                    const bodyMatch = rawText.match(/<body[^>]*>/i);
                    if (bodyMatch && bodyMatch.index !== undefined) {
                        rawText = rawText.slice(bodyMatch.index);
                    }
                    rawText = rawText
                        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                        .replace(/<style[\s\S]*?<\/style>/gi, ' ');
                    content = rawText.replace(/<[^>]*>/g, ' ');
                } finally {
                    await fd.close();
                }
            } else if (ext === '.json') {
                // Try a full structural parse so the snippet carries real key/value text
                // instead of a raw-byte prefix truncated mid-token.
                const stats = await fs.stat(filePath);
                if (stats.size <= 256 * 1024) {
                    const raw = await fs.readFile(filePath, 'utf-8');
                    try {
                        const parsed = JSON.parse(raw);
                        content = FileContentExtractor.extractTextFromParsedObject(parsed);
                    } catch {
                        content = raw.slice(0, 4096);
                    }
                } else {
                    const fd = await fs.open(filePath, 'r');
                    try {
                        const buffer = Buffer.alloc(4096);
                        const { bytesRead } = await fd.read(buffer, 0, 4096, 0);
                        content = buffer.toString('utf-8', 0, bytesRead);
                    } finally {
                        await fd.close();
                    }
                }
            } else if (ext === '.txt' || ext === '.md') {
                // Read a larger window to save memory while still reaching past any
                // leading frontmatter/TOC before the 600-char truncation below.
                const fd = await fs.open(filePath, 'r');
                try {
                    const buffer = Buffer.alloc(8192);
                    const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
                    content = buffer.toString('utf-8', 0, bytesRead);
                } finally {
                    await fd.close();
                }
            }
        } catch (e) {
            console.error(`Failed to extract content for ${filePath}: ${e}`);
        }

        if ((ext === '.pptx' || ext === '.ppt') && officeParseAst !== null){
            content = FileContentExtractor.extractTextFromParsedObject(officeParseAst);
        }
        // Clean up and truncate
        if (typeof content !== 'string') {
            content = FileContentExtractor.extractTextFromParsedObject(content);
        }
        content = (content || '').replace(/\s+/g, ' ').trim();
        if (content.length > 600) {
            content = content.substring(0, 600) + '...';
        }

        return { baseName, snippet: content };
    }
}

