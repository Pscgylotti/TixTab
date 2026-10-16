# PDF object editing: current state, Foxit comparison and implementation list

Audit date 2026-10-16, branch `claude/pdf-object-audit` (from `78b5088`). Foxit
behaviour is taken from its Windows user guide, not tested hands-on.

## Current capability (verified)

Engine: the **PDF 元素** tool sends the page to `backend/pdf_editor.py`, a
short-lived PyMuPDF 1.28.2 process from the optional `pdf-runtime` download.
Edits are staged in the project, previewed by MuPDF, and applied by redacting
the original area and re-inserting new content.

Probe of a page with every common object type (`scripts/probe-pdf-object-editing.py`):

| Object | Detected | Editable |
|---|---|---|
| Horizontal text span | yes, one element per span/line | content, size, colour, position, box |
| Paragraph | no, split into separate lines | per line only; a longer line runs past the paragraph (x 281 → 553), no reflow |
| Mixed-style line | yes, one element per span | per span; following spans are not reflowed |
| CJK text | yes | yes, original font kept (Heiti) |
| Rotated text | yes | **blocked** (`rotated-text`) |
| Text inside a form XObject | yes, as page text | yes, but re-inserted on the page outside the form |
| Axis-aligned image | yes | move, resize, replace, delete |
| Rotated / skewed / clipped image | yes | **blocked** (`complex-image`) |
| Shared image (same XObject twice) | yes, per occurrence | yes, occurrence-local |
| Vector paths (rect, line, bézier, dashed) | **no** (0 of 5) | no |
| Shading (`sh`) | **misreported as an image** | blocked, and it blocked a neighbouring image (`overlapping-elements`) |
| Annotations | not part of the tool | no |

UI: one selected element at a time; dialog with text, size, colour and
X/Y/W/H fields; drag and corner-resize on the page; batch apply; undo reloads
the previous PDF. The existing end-to-end test passes in all three views.

Fidelity limits seen in code:

- Re-inserted content uses `overlay=True`, so an edited object moves to the top
  of the page's drawing order.
- New text is re-typeset by PyMuPDF; original spacing operators are not kept.
- The preview is rendered by MuPDF while the app renders with PDFium.

## Foxit PDF Editor "Edit Object" comparison

| Area | Foxit | TixTab now |
|---|---|---|
| Object types | Text, image, shape/path, shading; filter by type or All | Text spans, plain images |
| Selection | Click, Ctrl/Shift-click, marquee, Ctrl+A | Single click |
| Move / resize | Drag, Shift keeps ratio, multi-object, Scale X/Y, alignment guides | Drag and corner resize, numeric X/Y/W/H, single object |
| Rotate | Handle with 15° snap, 90° buttons, numeric angle | None; rotated content is blocked |
| Flip / shear | Flip H/V; shear angle (Pro) | None |
| Align / distribute | Align, page-centre, distribute | None |
| Z-order | Front, back, forward, backward | None; edits jump to front |
| Clip | Add/edit/clear clip shapes (Pro) | None |
| Text | Edit in place, merge/split text objects, remove kerning, convert to shape; paragraph editing, reflow, link/join boxes, find/replace, spell check | Per-span content, size, colour; no reflow |
| Image | Image editor, edit externally and replace | Replace with a file, delete |
| Shape / shading | Format tab styles | Not available |
| Delete / cut / paste | Yes, multi-object | Delete single object |

## Key enabler

The bundled `@embedpdf/pdfium` WASM build already exports the object-editing
API: `FPDFPage_GetObject`, `FPDFPage_InsertObjectAtIndex`,
`FPDFPage_RemoveObject`, `FPDFPageObj_Transform`/`SetMatrix`,
`FPDFPageObj_Set{Fill,Stroke}Color`/`SetStrokeWidth`/`SetDashArray`,
`FPDFPath_*` segments, `FPDFText_SetText`/`LoadFont`, `FPDFImageObj_SetBitmap`,
`FPDFPageObj_TransformClipPath`, `FPDFPage_GenerateContent`, `FPDF_SaveAsCopy`.
Moving object editing onto it removes the Python download, edits objects by
matrix instead of redact-and-reinsert, keeps drawing order, and previews with
the same renderer the app displays.

## Implementation list

### P0: foundation and fixes

1. Stop treating shadings as images; the misdetection currently blocks
   unrelated nearby images.
2. Prototype a PDFium page-object model in the existing PDFium worker:
   enumerate objects (type, bounds, matrix, z-index, form nesting), apply a
   transform, regenerate content, save. Compare output with the PyMuPDF path on
   the probe fixture before switching.
3. Keep drawing order on edit (modify in place or insert at the original index).
4. Decide what stays on PyMuPDF (likely: text-content replacement needing new
   glyph subsets, and true removal of hidden content).

### P1: Foxit "Edit Object" parity

5. Detect all object types: text, path, image, shading, form XObject (as a
   group, with "edit inside").
6. Type filter: All / Text / Image / Path / Shading.
7. Multi-select: Shift/Ctrl-click, marquee, Ctrl+A; move and resize as a set.
8. Rotate (handle, 15° snap, ±90°, numeric), flip H/V, shear, all by matrix.
   This also lifts the current rotated-text and complex-image blocks.
9. Z-order: front, back, forward, backward.
10. Align, distribute, centre on page; alignment guides; arrow-key nudge.
11. Delete, cut, copy, paste and duplicate native objects, including across
    pages.
12. Path/shape style: stroke colour, width, dash, cap, join, fill, opacity.

### P2: deeper editing

13. Text: paragraph grouping and reflow, font family, bold/italic, character
    and word spacing, alignment, merge/split text objects.
14. Clip paths: add, edit, clear.
15. Images: extract/save, crop, opacity, edit externally and replace.
16. Convert text to path; add new native text, image and shape objects (or
    flatten a TixTab overlay object into native content).
17. Find and replace across native text.

### P3: pen and touch

18. 44 px handle hit areas, long-press context menu, two-finger pan while a
    selection is active, rotation handle usable with the pen.
19. Per-object undo steps and live PDFium preview during drag.

### Test coverage to add

- Keep the probe fixture (text, CJK, rotated text, paths, shading, form
  XObject, rotated/shared/clipped images, annotation) as a regression input.
- For each operation: pixels outside the edited bounds unchanged; object count
  and order preserved; text still extractable; output opens in PDFium and
  MuPDF.

## Progress (2026-10-16)

Done in this branch, uncommitted:

- P0.1 Shadings no longer listed as images by the PyMuPDF editor (`fill-shade`
  in MuPDF's drawing log); the false `overlapping-elements` block is gone.
- P0.2/P0.3 PDFium object engine `src/pdfiumObjects.ts`: list objects (kind,
  rotated bounds, matrix, text, font, size, colours), transform with clip,
  restyle, delete, restack, regenerate content, save. Edits keep drawing order.
  No-op regeneration was pixel-identical on 160 sampled pages of 41 real PDFs
  plus a stress corpus; real-document moves changed no pixels outside the moved
  object (5 documents, 70–340 ms per list+edit+save).
- P1.5–P1.10 (partly) in `PdfObjectLayer.tsx`, the new default mode of the
  PDF 元素 tool: all object types with a type filter, click/Shift/Ctrl/marquee/
  Ctrl+A selection, move, corner scale (Shift uniform), rotation handle (Shift
  15°), ±90° rotate, flip H/V, front/forward/backward/back, align ×6,
  distribute ×2, arrow nudge (Shift ×10, merged into one edit), Delete. Each
  action is one undoable PDF edit. Text content and image replacement stay on
  the PyMuPDF path ("编辑文字内容").

Second pass:

- Live drag preview: when a move, scale or rotate starts, the worker renders the
  selection alone and the page behind it (objects hidden only for that render),
  converted to night colours when night mode is on. The selection's real pixels
  follow the pen; outlines show until the bitmaps arrive (one render, no work
  per frame).
- Fill, stroke and line-width controls for selected paths (fill for text),
  debounced and merged into one edit.
- 36 px invisible hit areas around the handles.

Not yet: shear, alignment guides, copy/paste/duplicate, opacity, form "edit
inside", text content editing on PDFium, and saving cost on very large files
(each edit re-saves the whole document).
