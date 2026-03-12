export interface AdapterConfig {
  projectRoot: string;
  templateId: string;
  toolNames: {
    compileContext: string;
    observe: string;
    getCompileAudit: string;
  };
}

export interface AdapterResult {
  filePath: string;
  created: boolean;
  content: string;
}
