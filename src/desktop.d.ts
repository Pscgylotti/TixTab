interface Window {
  surfaceDesktop?: {
    editCommand?: (
      command: 'selectAll' | 'cut' | 'copy' | 'paste' | 'undo' | 'redo',
    ) => Promise<boolean>;
    runtimes?: import('./runtimeBridge').RuntimeBridge;
    dictation?: {
      run: (
        request: Record<string, unknown>,
      ) => Promise<{ ok: boolean; data?: any; error?: string }>;
    };
    chatgpt?: import('./chatgpt').ChatBridge;
    zotero?: import('./zotero').ZoteroBridge;
    caches?: import('./cacheLibrary').CacheLibraryBridge;
    models?: import('./modelLibrary').ModelLibraryBridge;
    providerHttp?: import('./providerTransport').ProviderHttpBridge;
    loadProviderSettings?: (
      feature: import('./providerSettings').ProviderSettingsFeature,
    ) => Promise<{
      status: 'encrypted' | 'session' | 'error';
      data: import('./providerSettings').ProviderRecord | null;
    }>;
    saveProviderSettings?: (
      feature: import('./providerSettings').ProviderSettingsFeature,
      data: import('./providerSettings').ProviderRecord,
    ) => Promise<{ status: 'encrypted' | 'session' | 'error' }>;
    getWindowVisible?: () => Promise<boolean>;
    onWindowVisibility?: (callback: (visible: boolean) => void) => () => void;
    getOnBattery?: () => Promise<boolean>;
    setNight?: (active: boolean) => Promise<void>;
    onPower?: (callback: (active: boolean) => void) => () => void;
    startNativeTexo: () => Promise<{ available: boolean }>;
    toggleFullscreen: () => Promise<boolean>;
    onFullscreen: (callback: (active: boolean) => void) => () => void;
  };
}
