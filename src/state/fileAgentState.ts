export class fileAgentState {
    public workspacePath: string = "";
    public fileListData: fileStatus[] = [];
    public filesCount: number = 0;
    public extensions: string[] = [];
    public lastReadInd: number = 0;
    public processId: string = "";
    public fileRecord : Record<string, fileStatus> = {}

    public AddFile(file : fileStatus){
        if(this.fileRecord[file.fileName] == undefined){
            this.fileListData.push(file);
            this.fileRecord[file.fileName] = file;
        }
    }
}

export class fileStatus{
    constructor(fileName: string, filePath: string, status: boolean = false, fileSize: number, ext : string) {
        this.fileName = fileName;
        this.filePath = filePath;
        this.status = status;
        this. fileSize = fileSize;
        this.ext = ext;
    }

    public fileName : string = "";
    public filePath : string = "";
    public status : boolean = false;
    public fileSize : number = 0;
    public ext : string = "";
}

export const fileAgentRecord: Record<string, fileAgentState> = {};