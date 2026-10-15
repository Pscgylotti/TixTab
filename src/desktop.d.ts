interface Window {
  surfaceDesktop?: {
    setUiScale?: (value: number) => boolean;
    penHaptics?: {
      run: (
        action: 'configure' | 'start' | 'stop' | 'status' | 'intensity',
        value?: boolean | string | number,
      ) => Promise<import('./usePenHaptics').HapticStatus>;
      onStatus: (callback: (status: import('./usePenHaptics').HapticStatus) => void) => () => void;
    };
    imageExport?: import('./imageExport').ImageExportBridge;
    batchPdf?: import('./batchWorkspace').BatchBridge;
    windowsAiOcr?: import('./windowsAiOcr').WindowsAiOcrBridge;
    nativeOcr?: import('./nativeCppOcr').NativeCppOcrBridge;
    pdfEditor?: import('./pdfNativeTypes').PdfEditorBridge;
    onNativePen?: (
      callback: (sample: import('./penInteraction').NativePenSample) => void,
    ) => () => void;
    createDesktopShortcut?: () => Promise<{ ok: boolean; error?: string; path?: string }>;
    openDocumentUrl?: (url: string) => Promise<boolean>;
    getPdfFilePath?: (file: File) => string;
    revealPdf?: (request: { path?: string }) => Promise<{
      ok: boolean;
      path?: string;
      cancelled?: boolean;
      error?: string;
    }>;
    editKey?: (key: import('./keyboardSelection').EditKey, select: boolean) => Promise<boolean>;
    openClipboardHistory?: () => Promise<boolean>;
    clipboardShelf?: import('./clipboardShelf').ClipboardShelfBridge;
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
