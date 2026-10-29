export type RuntimeId = 'openvino' | 'speech' | 'pdf' | 'homr' | 'copista' | 'matchmaker';
export type RuntimeSources = {
  packages: 'auto' | 'pypi' | 'tuna' | 'ustc' | 'custom';
  python: 'auto' | 'github' | 'npmmirror';
  customIndex: string;
};
export type RuntimeState = { installed: boolean; devices: string[]; installing?: RuntimeId };
export type RuntimeProgress = {
  id: RuntimeId;
  stage: 'check' | 'download' | 'extract' | 'environment' | 'dependencies' | 'verify' | 'idle';
  done: number;
  total: number;
  source?: 'github' | 'npmmirror' | 'pypi' | 'tuna' | 'ustc' | 'custom';
};
export type RuntimeDiagnostics = {
  id: RuntimeId;
  installing: boolean;
  stage: RuntimeProgress['stage'];
  source?: RuntimeProgress['source'];
  startedAt?: number;
  updatedAt: number;
  logs: string;
};
export type RuntimeBridge = {
  run(request: {
    id: RuntimeId;
    action: 'status' | 'install' | 'cancel' | 'diagnostics' | 'sources' | 'configure-sources';
    sources?: RuntimeSources;
  }): Promise<{
    ok: boolean;
    data?: RuntimeState;
    error?: string;
    diagnostics?: RuntimeDiagnostics;
    sources?: RuntimeSources;
  }>;
  onProgress(callback: (value: RuntimeProgress) => void): () => void;
};
