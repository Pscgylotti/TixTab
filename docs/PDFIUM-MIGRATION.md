# PDFium WASM migration

Current branch: `codex/pdfium-wasm`. Original checkpoint: `9d954d5`; previous image migration checkpoint: `9ccaecb`. Packaged in version 0.3.4. See [release notes](releases/0.3.4.md). The installer and packaged application are not launched on this validation host.

## Completed removal

PDFium is the sole reading engine. `pdfjs-dist` and its optional package dependencies have been removed from package.json and the lockfile. The legacy loader, decoder, custom image-index worker generator, operator-list indexing/culling, renderer fallback, upstream type imports and engine selector have been removed. The generated legacy index worker was deleted; current Vite dependencies and production assets contain no PDF.js runtime. Historical performance evidence and validation records remain unchanged.

The production build contains one local PDFium WASM asset and one reading worker. It does not download an engine from a CDN. Third-party notices include the package license and LICENSE.pdfium.

## Responsibilities and resource ownership

- PDFium supplies page/tile/thumbnail pixels, text geometry, outlines, named destinations, links and original-image decoding. Ordinary pages render directly with progressive continuation and cancellation. Uncommon viewport offsets, rotation overrides, flips and affine transforms use a bounded clipped intermediate surface, released in finally.
- Application-owned contracts in pdfTypes.ts and the viewport/text DOM builders replace upstream classes and types. Search, selection, translated text, OCR word boxes and URL/arXiv/mailto detection use shared oriented geometry. Native loose glyph bounds can differ slightly from font advance metrics; representative text remains selectable and vertical link bounds remain vertical.
- pdf-lib remains responsible for PDF structure and export. A transient dictionary/content parse reads CropBox/rotation/UserUnit and small source-image descriptors; it does not decode image pixels during inventory. It handles nested forms, repeated images, inline image boundaries, stencil exclusion and annotation appearances. The parsed object graph is discarded after indexing.
- An isolated decoder worker owns one OCR/export batch. Ordinary source images use the native object decoder. Clips, inline images, page graphics state and annotation images can be decoded from a tiny standalone PDF containing the original encoded image and its intrinsic color/mask resources. Page-level clips, opacity and blending are not baked into the extracted original. This also preserves saved OCR image ordering for the tested legacy fixtures.
- The decoder reuses reader metadata and transfers its owned file bytes without another whole-file clone. Special extraction lazily parses source structure inside that isolated worker. Native pages, image bitmaps and temporary PDFs close promptly; batch completion/stop terminates the worker and its entire heap.
- The initialized reading engine stays resident, as requested. Closing a document releases its handles, buffers and form environment. WASM linear memory retains its high-water allocation for reuse; zero live documents does not imply that total process RAM immediately returns to startup.
- Standard AcroForm values and checkboxes use PDFium's separate static widget drawing pass. Its callback structure and environment are owned until document close; no form input, document actions or JavaScript platform are wired. See the [official form drawing/lifecycle contract](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_formfill.h). Editable forms/XFA are not newly implemented here.
- Native element editing still uses the existing short-lived PyMuPDF helper. Preview failures now retain the original-page mirror, report the specific error and offer retry; cancelling a stale preview cannot indefinitely block later queued edits. The source PDF changes only on Apply PDF edits or export.

## Related interaction changes

Screenshot and crop selection may start/end in outside whitespace; both preview endpoints and sampled coordinates clamp to the selected PDF page. Capture uses the nearest visible page; crop remains restricted to its specified page. Mouse and touch share the same geometry.

Image extraction shows an asynchronously updated count for current/all/specified pages, including inserted/grouped bitmap objects. It reads metadata only, debounces range input and cancels stale counts on scope changes/close. It creates no image decoder just to count.

In continuous batch annotation, a file opened for the first time inherits the preceding file's view mode only. Previously opened files restore their own saved view and position.

## Validation and remaining boundaries

See [the user acceptance checklist](PDFIUM-ACCEPTANCE.md) for manual checks and the final verification record. Browser checks cover source geometry, masks, inline/AP images, pixels/alpha, source extraction, OCR/search, selection, links, all three views, scanned-page zoom transitions, export preservation, static forms, native previews, cancellation and worker lifetimes. Export structure is checked independently with pdf-lib, rather than through removed PDF.js private APIs.

The preservation comparison intentionally excludes the border of a link whose destination page was deleted: removing that link changes its visible border by design. Source fields, values, annotations, page labels, navigation and unaffected pixels are checked separately.

The existing cross-viewer boundary remains: static form widgets may be drawn above other PDF annotations, including exported stamps over fields. Foreground application ink is still above the PDF background. Complex transparency/image masking, unusual fonts, XFA and producer-specific damaged inline streams require representative real-document checks; synthetic cases do not establish universal PDF compatibility.

No new process-memory, latency, energy or repeated-run-average claim is made. Packaged Electron and installer execution are excluded from this host's automated checks. Prior hybrid-engine measurements are archived evidence for that earlier implementation, not measurements of this final migration.

### Final verification — 2026-10-15

- Unit tests: 502 passed across 107 files. The first default-concurrency run had two 5-second timeouts; both passed in isolation, then the full suite passed with one worker and a 15-second timeout. No product or test assertions were relaxed for these timeouts.
- Browser functional regression: 58 passed across 21 selected spec files, one worker. This includes continuous-batch view inheritance, image-range inventory without a decoder, outside-page capture/crop, static form appearances, native preview failure/retry and actual short-lived PyMuPDF edit/apply/undo.
- TypeScript and production build passed; repository formatting and `git diff --check` passed. Existing chunk-size/mixed-import warnings remain.
- Dependency and asset audit: `npm ls pdfjs-dist --all` is empty; package/lock/runtime sources contain no PDF.js dependency or legacy index worker. Generated legacy worker and installed PDF.js package are absent. Production assets contain `pdfium-BJ2Yip8Q.wasm` (4,646,932 bytes) and `pdfium.worker-DFfKJ_xn.js` (704,836 bytes), with no PDF.js worker/chunk.
- Frozen workflow/performance harness files remain unchanged. Existing 0.3.3 lite installer SHA256 remains `d6f09e42169dcabb8375a9c09f42cc23f98cf8a790e94b01a4216cb5f54a820f`; no installer was rebuilt or launched.

### Follow-up: vector-heavy document opening and file locations

The reported `[Website] Diffusion-Flow.pdf` is 6,206,396 bytes, 10 pages, with 32,594,871 decoded content-stream bytes and four image occurrences. The eager source-image scan spent substantial time allocating numeric PDF objects and issuing one OS timer per 2,048 tokens. It now retains numeric operands as primitives, reuses its operator decoder and yields after elapsed work while retaining bounded cancellation checks. One Node pass per candidate measured image indexing at 23,706.6 ms before, 4,693.2 ms after timed yielding/decoder reuse, and 1,449.4 ms after primitive coordinates. This is scanner timing, not whole-application timing or repeated-run statistics. A separate final browser pass opened the actual file in 1,492.9 ms and rendered its first half-scale page in another 47.1 ms; input fetching and workspace persistence are outside that interval. It found four image occurrences and used no isolated decoder worker.

PDF tab menus now reveal their original file through Electron. Imported local paths persist only in workspace metadata and are omitted from portable project exports. An old tab without a path prompts for its original PDF once. Inactive tabs read metadata only, without loading their PDF or changing the active view; batch tabs resolve the current file through the existing folder grant. Nineteen targeted unit tests, seventeen browser regressions, the one actual-file browser check, TypeScript and production build passed. Packaged Electron/Explorer were not launched on this host.
