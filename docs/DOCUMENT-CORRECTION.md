# Local document correction

Open **Extra tools → Document correction**. Choose the current page, all pages, a page range, or **Pick an image**. Batch processing extracts one target at a time, bounds each image to four million pixels, and releases its owned Python process and image buffers after processing. Geometry, DocAligner and UVDoc all reuse the existing OpenVINO Python environment.

| Scene | Default | Alternatives / manual controls |
|---|---|---|
| Tilted scans | Text projection deskew | Hough-line deskew; rotation ±180° |
| ID-card photographs | DocAligner FastViT T8 corners | Four-corner adjustment; landscape/portrait ID-card ratio |
| Perspective photographs | Contour-based quadrilateral | DocAligner or manual four corners |
| Curved book pages | UVDoc | Shared text-line curvature heuristic; 5×5 manual mesh |
| Creased documents | UVDoc | Flatten strength, manual mesh, shadow balancing |
| Manual calibration | Explicit geometry | Four corners or mesh; output ratio, rotation, shadow balancing |

DocAligner is the upstream 1.1.1 [FastViT T8 model](https://github.com/DocsaidLab/DocAligner), about 13 MB, with verified size/hash and Apache-2.0 license. TixTab runs its BGR/255 heatmap pipeline directly in OpenVINO. Batch is fixed to one before compilation to support NPU static-shape requirements. CPU and NPU detection were tested on the upstream sample card, producing identical detected corners on this machine. Explicit unsupported devices report an error; AUTO can fall back to CPU. UVDoc retains its existing OpenVINO backend. Geometry methods require no model download.

**Select image and adjust** loads the target without applying a correction. The editor initially fits the whole image. Drag the four corners onto document edges, or place mesh points on their corresponding original-image positions; the grid is unfolded into a regular output grid. Mouse, pen/touch and keyboard arrows work; Shift moves points farther. Zoom supports finer adjustments. The hit area stays usable when zooming. Crossing/folded controls are rejected rather than producing corrupt geometry.

**Update preview** shows before/after images and an optional wipe comparison. Changing any correction invalidates the Apply button until the preview is updated. **Continue adjusting this result** starts another correction pass; Reset returns to the original target. Manual point coordinates cannot be batch-applied to unrelated images and are cleared when changing scope. Batch operations still support the algorithm/rotation/ratio/lighting settings.

Corrections produce an editable bitmap replacement beneath handwriting, preserve original PDF bytes, and participate in undo/project saving. Source bitmap OCR and score metadata are invalidated where appropriate. The corrected output's aspect ratio is preserved; source PDF replacements use white padding inside the original footprint so a corrected card is not stretched back. Already placed image objects update their proportions. This is raster correction, not vector PDF layout editing or generative text repair. Book-line flattening abstains when it cannot find consistent text curves; severe folds, missing content and blurred text may still need manual calibration or a better source scan.

Verification: try a tilted text scan, a skewed ID card and a curved book page; adjust a corner and a mesh point; compare/update/apply, undo, reopen the project, and export. Check batch current/all/range and cancellation, and confirm handwriting remains above the corrected image.
