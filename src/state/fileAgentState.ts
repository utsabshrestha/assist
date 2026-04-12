export class fileAgentState {
    public fileList : string[] = [];
    public filesCount : number = 0;
    public extensions : string[] = [];
    public lastReadInd : number = 0;
}

export const fileAgentRecord: Record<string, fileAgentState> = {};