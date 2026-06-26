/**
 * Deterministic extension → category lookup for non-document files.
 * Extensions not found here fall back to LLM categorization (see
 * FileClassificationTool.GetNonDocumentExtensionCategorized).
 */
export const EXTENSION_CATEGORY_MAP: Record<string, string> = {
    // Video
    '.mp4': 'Video', '.mkv': 'Video', '.mov': 'Video', '.avi': 'Video',
    '.webm': 'Video', '.wmv': 'Video', '.flv': 'Video', '.m4v': 'Video',
    '.mpg': 'Video', '.mpeg': 'Video', '.3gp': 'Video',

    // Audio
    '.mp3': 'Audio', '.flac': 'Audio', '.wav': 'Audio', '.aac': 'Audio',
    '.ogg': 'Audio', '.m4a': 'Audio', '.wma': 'Audio', '.opus': 'Audio',
    '.aiff': 'Audio',

    // Archives
    '.zip': 'Archives', '.tar': 'Archives', '.gz': 'Archives', '.rar': 'Archives',
    '.7z': 'Archives', '.bz2': 'Archives', '.xz': 'Archives', '.tgz': 'Archives',
    '.iso': 'Archives',

    // Code_Scripts
    '.js': 'Code_Scripts', '.ts': 'Code_Scripts', '.jsx': 'Code_Scripts', '.tsx': 'Code_Scripts',
    '.py': 'Code_Scripts', '.sh': 'Code_Scripts', '.rb': 'Code_Scripts', '.go': 'Code_Scripts',
    '.cpp': 'Code_Scripts', '.c': 'Code_Scripts', '.h': 'Code_Scripts', '.java': 'Code_Scripts',
    '.cs': 'Code_Scripts', '.php': 'Code_Scripts', '.rs': 'Code_Scripts', '.swift': 'Code_Scripts',
    '.kt': 'Code_Scripts', '.bat': 'Code_Scripts', '.ps1': 'Code_Scripts', '.sql': 'Code_Scripts',

    // Apps_Packages
    '.apk': 'Apps_Packages', '.dmg': 'Apps_Packages', '.exe': 'Apps_Packages', '.deb': 'Apps_Packages',
    '.rpm': 'Apps_Packages', '.ipa': 'Apps_Packages', '.msi': 'Apps_Packages', '.pkg': 'Apps_Packages',
    '.appimage': 'Apps_Packages',

    // Data_Markup
    '.xml': 'Data_Markup', '.yaml': 'Data_Markup', '.yml': 'Data_Markup', '.toml': 'Data_Markup',
    '.ini': 'Data_Markup', '.cfg': 'Data_Markup', '.conf': 'Data_Markup', '.log': 'Data_Markup',
};

export function lookupExtensionCategory(extension: string): string | undefined {
    const normalized = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    return EXTENSION_CATEGORY_MAP[normalized];
}
