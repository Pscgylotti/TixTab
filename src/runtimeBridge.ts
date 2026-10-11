export type RuntimeId = 'openvino' | 'speech';
export type RuntimeState = { installed: boolean; devices: string[]; installing?: RuntimeId };
export type RuntimeProgress = {
  id: RuntimeId;
  stage: 'check' | 'download' | 'extract' | 'environment' | 'dependencies' | 'verify' | 'idle';
  done: number;
  total: number;
};
export type RuntimeBridge = {
  run(request: {
    id: RuntimeId;
    action: 'status' | 'install' | 'cancel';
  }): Promise<{ ok: boolean; data?: RuntimeState; error?: string }>;
  onProgress(callback: (value: RuntimeProgress) => void): () => void;
};
