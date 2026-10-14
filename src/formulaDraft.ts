import { get, set, keys, delMany } from 'idb-keyval';
import { performanceLedger, trackPerformance } from './performanceLedger';
import { validMacroSnapshot, validNotebook, type Stroke } from './model';
import type { LatexMacros } from './latexMacros';

export interface FormulaDraft {
  version: 1;
  latex: string;
  position: number;
  strokes: Stroke[];
  multiline: boolean;
  byRow: boolean;
  macros: LatexMacros;
  macroDraft: string;
}
const prefix = 'tixtab.formula.draft.v1:';
export const formulaDraftKey = (documentId: string, objectId?: string) =>
  `${prefix}${encodeURIComponent(documentId)}:${encodeURIComponent(objectId ?? 'new')}`;

export function validFormulaDraft(value: unknown): value is FormulaDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as FormulaDraft;
  return (
    d.version === 1 &&
    typeof d.latex === 'string' &&
    d.latex.length <= 100_000 &&
    Number.isInteger(d.position) &&
    d.position >= 0 &&
    d.position <= d.latex.length &&
    typeof d.multiline === 'boolean' &&
    typeof d.byRow === 'boolean' &&
    typeof d.macroDraft === 'string' &&
    d.macroDraft.length <= 100_000 &&
    validMacroSnapshot(d.macros) &&
    Array.isArray(d.strokes) &&
    d.strokes.length <= 10_000 &&
    d.strokes.every((s) => s && Array.isArray(s.points) && s.points.length <= 100_000) &&
    validNotebook({
      version: 1,
      name: 'formula draft',
      source: null,
      pages: [
        {
          id: 'draft',
          sourceIndex: null,
          width: 960,
          height: 640,
          paper: 'plain',
          images: [],
          strokes: d.strokes,
        },
      ],
    })
  );
}

export async function loadFormulaDraft(key: string): Promise<FormulaDraft | undefined> {
  const draft: unknown = await trackPerformance('formula-load', () => get(key));
  return validFormulaDraft(draft) ? draft : undefined;
}

export function saveFormulaDraft(key: string, draft: FormulaDraft) {
  // Snapshot before the asynchronous database open, so later pen events cannot mutate it.
  return trackPerformance('formula-save', () => {
    const promise = set(key, structuredClone(draft));
    if (performanceLedger)
      void promise.then(
        () => performanceLedger?.count('formulaWrites'),
        () => {},
      );
    return promise;
  });
}

export async function deleteFormulaDrafts(documentId: string) {
  const documentPrefix = `${prefix}${encodeURIComponent(documentId)}:`;
  await delMany(
    (await keys()).filter((key) => typeof key === 'string' && key.startsWith(documentPrefix)),
  );
}
