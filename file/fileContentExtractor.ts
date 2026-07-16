import * as fs from 'fs/promises';
import type { OfficeParserAST } from 'officeparser';
import * as path from 'path';
import { EmbeddingService } from '../EmbeddingService.js';

/**
 * Gets EXACT token counts from the local embedding model tokenizer,
 * instead of guessing from character length or calling an external server.
 */
class TokenCounter {
    private static async countViaLocalModel(text: string): Promise<number> {
        const embeddingService = await EmbeddingService.getInstance();
        return embeddingService.countTokens(text);
    }

    public static async count(text: string): Promise<number> {
        return this.countViaLocalModel(text);
    }

    /**
     * Trims `text` so that `prefix + text` tokenizes to at most `targetTokens`.
     * Slices on code points (via Array.from), not raw string indices - a
     * plain `.slice()` cuts on UTF-16 code units and can split a surrogate
     * pair (emoji, rare CJK/math symbols) in half, producing a lone surrogate
     * that corrupts the JSON payload sent to the server. Ratio-estimates the
     * cut point from the actual overshoot, then verifies against the real
     * tokenizer - a couple of passes handle the fact that cuts near
     * multi-byte runs aren't perfectly linear.
     */
    public static async fitToBudget(text: string, targetTokens: number, prefix = ''): Promise<string> {
        const codePoints = Array.from(text);
        let len = codePoints.length;
        let tokenCount = await this.countViaLocalModel(prefix + codePoints.join(''));
        if (tokenCount <= targetTokens) return text;

        for (let i = 0; i < 4 && tokenCount > targetTokens; i++) {
            const ratio = len / tokenCount;
            const overshoot = tokenCount - targetTokens;
            const cutChars = Math.max(1, Math.ceil(overshoot * ratio * 1.15)); // 15% safety pad
            len = Math.max(0, len - cutChars);
            tokenCount = await this.countViaLocalModel(prefix + codePoints.slice(0, len).join(''));
        }
        // Fallback for pathological content that didn't converge above
        while (tokenCount > targetTokens && len > 0) {
            len = Math.floor(len * 0.9);
            tokenCount = await this.countViaLocalModel(prefix + codePoints.slice(0, len).join(''));
        }
        return codePoints.slice(0, len).join('');
    }
}

/**
 * Cheap, format-agnostic cleanup applied to every extracted snippet before
 * token counting. This raises signal-to-noise (and shrinks size as a side
 * effect) - it is NOT what enforces the token budget. That job belongs to
 * TokenCounter.fitToBudget, since no regex list can *guarantee* a hard limit
 * the way measuring real tokens can.
 */
function sanitizeForEmbedding(raw: string): string {
    let s = raw;

    // Fold combining-character / compatibility unicode variants to one form -
    // some PDF/OCR extraction leaves decomposed sequences that tokenize worse
    // than their normalized equivalent.
    s = s.normalize('NFKC');

    // The .html path strips tags but never decodes entities - decode the
    // common ones, blank out anything else unrecognized.
    s = s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&[a-z]+;|&#\d+;/gi, ' ');

    // Zero-width / control characters - common byproduct of OCR or wrong
    // encoding detection, and each one tends to tokenize as its own junk token.
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\uFEFF]/g, '');

    // "Dot leader" runs from PDF tables of contents (....................)
    // and similar repeated-symbol runs can silently burn hundreds of tokens.
    s = s.replace(/([.\-_=*#~^])\1{4,}/g, '$1$1$1');

    // Long unbroken hex/base64-looking runs (embedded image data, hashes,
    // UUIDs pulled from JSON) - expensive in tokens, ~no naming signal.
    s = s.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, ' ');

    return s.replace(/\s+/g, ' ').trim();
}

export class FileContentExtractor {
    // nomic-embed-text-v1.5 requires a task prefix at embed time
    // ("search_document: " / "search_query: "), which also eats into the
    // context budget - reserved here rather than added silently downstream.
    private static readonly EMBED_PREFIX = 'clustering : ';
    private static readonly TARGET_TOKENS = 3900; // safety margin under 2048

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
     * Extracts a snippet of text from the given file, sanitized and trimmed
     * to fit under the embedding model's real token budget (not just a
     * character count). Filename and content are returned separately so
     * callers can choose whether to embed/display them together or apart.
     */
    public static async extractContent(filePath: string): Promise<{ baseName: string; snippet: string }> {
        const ext = path.extname(filePath).toLowerCase();
        const baseName = path.basename(filePath);
        let content = '';
        let officeParseAst: OfficeParserAST = null;

        try {
            if (ext === '.pdf') {
                const pdfParseM = await import('pdf-parse/lib/pdf-parse.js');
                // @ts-ignore
                const pdfParse = pdfParseM.default || pdfParseM;
                const dataBuffer = await fs.readFile(filePath);
                const data = await pdfParse(dataBuffer, { max: 15 }); // First 10 pages approx
                content = data.text || '';
            } else if (ext === '.docx' || ext === '.doc') {
                const mammothM = await import('mammoth');
                const mammoth = mammothM.default || mammothM;
                try {
                    const result = await mammoth.extractRawText({ path: filePath });
                    content = result.value || '';
                } catch (mammothErr: any) {
                    if (mammothErr.message?.includes("Can't find end of central directory")) {
                        // Orphaned Office lock files (~$filename.docx) or corrupted files.
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
                const fd = await fs.open(filePath, 'r');
                try {
                    const buffer = Buffer.alloc(131072);
                    const { bytesRead } = await fd.read(buffer, 0, 65536, 0);
                    let rawText = buffer.toString('utf-8', 0, bytesRead);
                    const bodyMatch = rawText.match(/<body[^>]*>/i);
                    if (bodyMatch && bodyMatch.index !== undefined) {
                        rawText = rawText.slice(bodyMatch.index);
                    }
                    rawText = rawText
                        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                        .replace(/<!--[\s\S]*?-->/g, ' ');
                    content = rawText.replace(/<[^>]*>/g, ' ');
                } finally {
                    await fd.close();
                }
            } else if (ext === '.json') {
                const stats = await fs.stat(filePath);
                if (stats.size <= 256 * 1024) {
                    const raw = await fs.readFile(filePath, 'utf-8');
                    try {
                        const parsed = JSON.parse(raw);
                        content = FileContentExtractor.extractTextFromParsedObject(parsed);
                    } catch {
                        content = raw.slice(0, 7000);
                    }
                } else {
                    const fd = await fs.open(filePath, 'r');
                    try {
                        const buffer = Buffer.alloc(65536);
                        const { bytesRead } = await fd.read(buffer, 0, 32768, 0);
                        content = buffer.toString('utf-8', 0, bytesRead);
                    } finally {
                        await fd.close();
                    }
                }
            } else if (ext === '.txt' || ext === '.md') {
                const fd = await fs.open(filePath, 'r');
                try {
                    const buffer = Buffer.alloc(65536);
                    const { bytesRead } = await fd.read(buffer, 0, 32768, 0);
                    content = buffer.toString('utf-8', 0, bytesRead);
                } finally {
                    await fd.close();
                }
            }
        } catch (e) {
            console.error(`Failed to extract content for ${filePath}: ${e}`);
        }

        if ((ext === '.pptx' || ext === '.ppt') && officeParseAst !== null) {
            content = FileContentExtractor.extractTextFromParsedObject(officeParseAst);
        }
        if (typeof content !== 'string') {
            content = FileContentExtractor.extractTextFromParsedObject(content);
        }

        // Sanitize first (raises signal-to-noise, shrinks size as a side
        // effect), then enforce the real token budget with the actual
        // tokenizer - character count alone can't guarantee that.
        content = sanitizeForEmbedding(content || '');

        try {
            content = await TokenCounter.fitToBudget(
                content,
                FileContentExtractor.TARGET_TOKENS,
                FileContentExtractor.EMBED_PREFIX
            );
        } catch (e) {
            // This path skips real token verification entirely, so it must be
            // conservative rather than merely "smaller than the normal target."
            // If this ever fires, it's worth investigating why /tokenize failed
            // for this specific file rather than trusting the fallback long-term.
            console.error(`Tokenizer fit failed for a file, falling back to a conservative char cap: ${e}`);
            //content = content.length > 500 ? content.slice(0, 500) + '...' : content;
            // AFTER: Scale up the fallback roughly proportional to your new target limit
            content = content.length > 12000 ? content.slice(0, 12000) + '...' : content;
        }

        return { baseName, snippet: content };
    }
}