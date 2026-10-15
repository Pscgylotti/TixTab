# PDFium WASM migration experiment

Checkpoint: `9d954d5` on `main`. Experiment branch: `codex/pdfium-wasm`. Package version stays 0.3.3; no new installer or release is published by this experiment.

Select **Settings → PDF rendering engine → PDFium WASM (experimental)**. PDF.js remains the default and can be selected again. The local `@embedpdf/pdfium` package is pinned to 2.15.1; its WASM asset ships with the application and does not require a CDN. Package and upstream PDFium licenses are included in the third-party notices.

## Current implementation

PDFium supplies page pixels for single, continuous and dual views, thumbnails, pre-rendered pages and clipped detail tiles. Intrinsic page rotation and CropBox are respected. Rendering runs in a Worker with progressive continuation, cancellation, serialized engine access and bounded output allocations. Completed ImageBitmaps are transferred and explicitly closed after presentation.

The initialized engine now stays resident across idle periods, document changes and rendering-backend changes. Documents use independent handles in the shared Worker; closing a document cancels its work, closes its native pages/document and frees its source buffer. A crash or timeout discards the failed Worker and allows later recreation. Retaining the engine also retains its WASM memory high-water allocation; freed blocks can be reused, but the browser does not shrink the linear-memory buffer. A retained heap is therefore not proof that closed documents remain live. Tests inspect native document counts, pending requests, initialization count and repeated-close heap stability.

The PDFium backend now owns the document/page facade, native text extraction, outline/link enumeration, named destinations and raster work. Opening a PDF and using native text/navigation do not create a PDF.js document. Shared viewport math is application-owned. Source boxes, page references, rotations and UserUnit are read once through an ephemeral pdf-lib dictionary parse in the Worker because PDFium's public ABI does not expose UserUnit. That auxiliary object graph is discarded after metadata extraction.

The remaining PDF.js runtime paths are its DOM TextLayer, image indexing and original-image decoding. The image adapter opens one lazy compatibility document for the custom metadata-only index; it never falls through to a full operator list on the PDFium facade. OCR decodes in a separate bounded, short-lived worker. Full operator-list fallback was found to decode images/fonts during inventory after the facade change and was removed. Cancellation stops waiting promptly; completed image geometry is reused by the dialog. Its raster renderer is not called for normal PDFium page/tile work. Navigation affine transformation no longer imports PDF.js `Util`; PDF.js loading and TextLayer are dynamic imports, removing their unconditional runtime imports from the application shell. Type-only imports do not load the engine.

Workspace sizes are saved separately for pen, ballpoint, pencil, highlighter and eraser. Erasing uses paper-space radius, mapped pen pressure without a minimum action radius and a matching preview circle. Barrel dragging suppresses all interaction highlights until tip release. Coalesced ink uses causal brush-relative noise filtering and smooth quadratic contours shared by live canvas/SVG/PDF export. Previously accepted centerline points are never globally refitted on append.

Workspace pen size is restored independently of documents. Each document saves its zoom, view, page and page-interior pan/scroll coordinates; switching tabs restores the actual position rather than resetting to the page top. Old records without these coordinates retain their former page-based behavior.

Alt+mouse now uses the same target/drag router as pen barrel input: pressing Alt reveals targets without needing mouse movement, hover emphasizes the target, and a tap activates it regardless of the current tool. With a drawing tool, crossing the six-screen-pixel drag threshold selects ink instead and hides interaction highlights. Alt release, blur and cancellation clear the mode. Text inputs and AltGr are excluded; generated click events are consumed so geometry activation happens once. All three views are covered by browser tests.

## Remaining stages and affected functions

| Stage | Remaining PDF.js coupling | Manual checks before retiring that path |
| --- | --- | --- |
| Raster — implemented | No normal raster dependency; shared geometry is app-owned | All three views; pinch/wheel zoom; high-resolution detail; fit page/width; pre-rendering; mixed page sizes; rotated/cropped pages; thumbnails; night/original colors |
| Document model — implemented for PDFium | PDF.js only loaded by remaining image features; transient pdf-lib metadata parse | Open/switch/reopen documents; continuous annotation; page reordering, insertion and deletion; crop/rotation; original PDF export alignment; encrypted/invalid PDF errors |
| Text model — native extraction implemented | DOM `TextLayer` and type definitions remain; native font families/metrics require broader script checks | Hover caret, paragraph starts, word/line selection, spaces, copy/translation/read aloud, search highlights, chat page attachments and full-document summary; Chinese, ligatures and rotated text |
| Navigation — implemented | App-facing types still use compatibility interfaces | Directory hierarchy; bookmarks after page edits; internal references; navigation back/forward; multiline URLs; arXiv/email recognition; pen interaction highlights |
| Image model | Operator lists, object cache and decoded images/masks | Double-click originals and save/zoom; image extraction scopes; bitmap counting/OCR progress/cancel; OCR text selection/search alignment; repeated images, soft masks, nested forms and night-mode dimming |
| Final removal | `pdfjs-dist`, its custom index Worker, remaining adapter types and test fixtures | Full regression suite, production build and manual checks above with PDF.js unavailable; inspect package contents and memory after document changes |

The next migration boundary is native image occurrence enumeration/decoding with identical ordering and mask behavior, followed by the DOM text layout replacement and retirement of PDF.js types. The current stage deliberately preserves the still-needed PDF.js paths so the checklist can be exercised before each replacement. PDF export uses pdf-lib and native PDF editing uses PyMuPDF, but both depend on the page coordinate conventions; they need alignment checks even though their engines are not being replaced.

## Validation and limits

Browser tests cover cropped/rotated raster fidelity, tile alignment, night colors, real text/image interactions, backend switching, cancellation and resident-engine reuse. Zoom tests retain a bounded CPU fallback and keep scanned page 179 mounted through repeated continuous zoom. Small handwritten curves keep raw/coalesced samples and use brush-relative causal filtering. Tests verify no refitting of accepted samples, curve export compatibility, short-stroke radius bounds and no needle artifacts on dense compact arcs.

Synthetic context loss is a recovery test, not a real GPU-reset test. No packaged application or installer is launched on this host. The archived raster measurements were taken before the native document/text/navigation facade was introduced; they do not establish the memory or speed of a future PDFium-only application. See [render measurements](performance/pdfium/render-20261015.md).

Upstream APIs: [PDFium progressive rendering](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_progressive.h), [EmbedPDF low-level PDFium package](https://www.embedpdf.com/docs/pdfium/getting-started).
