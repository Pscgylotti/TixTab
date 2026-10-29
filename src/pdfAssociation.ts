/** Immutable identity of the imported PDF, retained when editing its embedded copy. */
export async function pdfFingerprint(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}

export function samePdfPath(a?: string, b?: string) {
  if (!a || !b) return false;
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

export interface ExternalDocument {
  path: string;
  name: string;
  bytes?: Uint8Array;
  error?: string;
}
export interface DocumentOpenBridge {
  next: () => Promise<ExternalDocument | null>;
  onRequest: (callback: () => void) => () => void;
}
