export type TodoStatus = 'not-started' | 'in-progress' | 'completed' | 'blocked' | 'failed';

export interface FolderPlanEntry {
    category: string;
    folder: string; // full absolute path
}
export interface CategorySummary {
    documents: string[];
    images: string[];
    "non-documents": string[];
}
export type AgentPhase = 'planning' | 'categorization' | 'execution' | 'done';
export interface FolderPreviewEntry {
    category: string;
    folder: string; // full absolute path, matches FolderPlanEntry.folder
    files: string[]; // truncated file name list
    totalFileCount: number; // untruncated count, for "+N more"
}
export interface TodoSubTask {
    extension: string;
    status: TodoStatus;
    /**
     * Finalized folder → file breakdown for this extension. Populated only after
     * Finalize runs — never shown before approval, so there's no staleness concern.
     */
    folderPreview?: FolderPreviewEntry[];
}
export interface TodoItem {
    id: number;
    title: string;
    status: TodoStatus;
    notes?: string;
    extensionList: string []
    /**
     * Per-extension sub-progress, populated only for the Documents task by
    * categorization code — never authored by the LLM, never part of CreateTodoListTool/ViewTodoListTool/UpdateTodoListTool's schema.
     */
    subTasks?: TodoSubTask[];
    /**
     * Finalized folder → file breakdown for this task. Populated only for Images/Non-Documents
     * tasks (which have no subTasks layer), only after Finalize runs.
     */
    folderPreview?: FolderPreviewEntry[];
}

export type PlanScope = 'documents' | 'images' | 'non-documents';

export interface PlanFileEntry {
    fileName: string;
    fileSize: number;
}

export interface PlanFolderEntry {
    category: string;
    folder: string; // full absolute path
    files: PlanFileEntry[]; // full list, no truncation
}

export interface PlanExtensionGroup {
    extension: string;
    folders: PlanFolderEntry[];
}

/**
 * Documents populates extensionGroups (proposedFolderPlan is keyed per-extension there);
 * Images/Non-Documents populate folders directly (proposedFolderPlan is keyed by
 * __task_${TaskId}, covering the whole task's extension list as a single unit).
 */
export interface PlanScopeGroup {
    scope: PlanScope;
    extensionGroups?: PlanExtensionGroup[];
    folders?: PlanFolderEntry[];
}

export class fileAgentState {
    public workspacePath: string = "";
    public fileListData: fileStatus[] = [];
    public filesCount: number = 0;
    public extensions: string[] = [];
    public lastReadInd: number = 0;
    public phase: AgentPhase = 'planning';
    public processId: string = "";
    public planConfirmed: boolean = false;
    public fileRecord : Record<string, fileStatus> = {};
    public fileByExtension : Record<string, fileStatus[]> = {};
    public todoList: TodoItem[] = [];
    public globalNotes: string[] = [];
    public planConfirmedFiles : fileStatus[] = [];
    /**
     * Latest folder plan, auto-computed by categorization tools. Keyed by extension for
     * documents (e.g. ".pdf"), or by `__task_${TaskId}` for images/non-documents, where one
     * task's entire extension list is organized as a single unit. Ground truth the LLM
     * reads back via Present*FolderPlanTool — never reconstructed from its own memory.
     */
    public proposedFolderPlan: Record<string, FolderPlanEntry[]> = {};
    /**
     * Category → extension list computed by GetFolderSummaryTool's scan.
     * Read directly by PresentScopeSelectionTool — never reconstructed by the LLM.
     */
    public categorySummary: CategorySummary = { documents: [], images: [], "non-documents": [] };
    public fileCountByExtension: Record<string, number> = {};
    public totalFileSizeLabel: string = "";

    public AddFile(file : fileStatus){
        if (this.fileByExtension[file.ext] == undefined){
            this.fileByExtension[file.ext] = [];
        }
        
        if(this.fileRecord[file.fileName] == undefined){
            this.fileListData.push(file);
            this.fileRecord[file.fileName] = file;
            this.fileByExtension[file.ext]?.push(file);
        }
    }
}

export class fileStatus{
    constructor(fileName: string, filePath: string, fileSize: number, ext : string) {
        this.fileName = fileName;
        this.filePath = filePath;
        this.planConfirmed = false;
        this. fileSize = fileSize;
        this.ext = ext;
    }

    public fileName : string = "";
    public filePath : string = "";
    public planConfirmed : boolean = false;
    public fileSize : number = 0;
    public ext : string = "";
    public category : string = "";
    public fileNewDestination : string = "";
    public isFileSuccessfullyMoved : boolean = false;
}

export const fileAgentRecord: Record<string, fileAgentState> = {};