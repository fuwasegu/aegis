export interface AdapterConfig {
  projectRoot: string;
  templateId: string;
  toolNames: {
    compileContext: string;
    observe: string;
    getCompileAudit: string;
  };
}

export type AdapterStatus = 'created' | 'updated' | 'unchanged' | 'skipped' | 'conflict' | 'failed';

export interface AdapterResult {
  filePath: string;
  status: AdapterStatus;
  content: string;
}
