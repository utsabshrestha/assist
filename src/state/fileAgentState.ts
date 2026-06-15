export type TodoStatus = 'not-started' | 'in-progress' | 'completed' | 'blocked' | 'failed';
export type AgentPhase = 'planning' | 'categorization' | 'execution' | 'done';
export interface TodoItem {
    id: number;
    title: string;
    status: TodoStatus;
    notes?: string;
    extensionList: string []
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
        this.status = false;
        this. fileSize = fileSize;
        this.ext = ext;
    }

    public fileName : string = "";
    public filePath : string = "";
    public planConfirmed : boolean = false;
    public fileSize : number = 0;
    public ext : string = "";
    public category : string = "";
    public folderPath : string = "";
}

export const fileAgentRecord: Record<string, fileAgentState> = {};