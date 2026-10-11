import type { CacheRow } from './browserCaches';
export interface CacheResult {
  ok: boolean;
  error?: string;
  rows?: CacheRow[];
  filesDeleted?: number;
  bytesDeleted?: number;
  failed?: number;
  preserved?: number;
}
export interface CacheLibraryBridge {
  list: () => Promise<CacheResult>;
  clear: (id: string, token: string) => Promise<CacheResult>;
  cancel: () => Promise<boolean>;
}
