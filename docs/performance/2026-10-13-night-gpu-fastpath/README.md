# Exact night GPU path and rounded-border experiment

The general GPU colour transform failed strict pixel checks in the preceding archive. Production now limits GPU work to opaque rasters entirely covered by a bitmap, using the exact 256-value CPU dimming curve. All other content uses the original CPU transform; resolution and density remain unchanged.

The repaired conservative path passed 144 raw worker pairs and 405 actual application canvas pairs. Its six complete workflows all reported **zero GPU conversions**, so their essentially unchanged CPU totals cannot establish GPU benefits.

A further candidate corrected fractional rounded PDF borders on the CPU and processed the solid interior on GPU. It passed 252 raw pairs and 405 application pairs. At the user's request, it received one complete A/B workflow comparison:

| Measurement | CPU reference | Border candidate |
| --- | ---: | ---: |
| Whole-flow CPU seconds | 21.718619 | 21.684657 |
| Elapsed milliseconds | 84794.128 | 84739.694 |
| Peak 200 ms core equivalent | 1.9435 | 2.1311 |
| GPU conversions | 0 | 39 |
| CPU-only conversions | 39 | 0 |
| Raster pixels | 80,373,660 | 84,882,570 |
| Source / formula saves | 1 / 2 | 1 / 2 |

Candidate GPU conversions include CPU strip corrections. Raster work differs; whole CPU cost is effectively flat and observed peak demand is higher. **The border expansion was withdrawn.** No repeated statistics, stable speedup or energy conclusion is claimed. The conservative exact GPU repair remains.

The manifest binds 4,617 files and deduplicated compressed content for four frozen applications, source manifests, unchanged workflow harnesses, eight resource reports and PNG evidence. `node scripts/archive-night-gpu-fastpath.mjs verify` checks hashes and independently decodes 396 raw pairs and 810 application pairs. It does not establish hardware energy savings or compatibility with other drivers.

Subsequent navigation/sidebar/thumbnail changes are outside these measured builds. The overall optimization goal and rounds two/three remain open. Further experiments use one comparison by default and focus on reducing computation, per the user's updated instruction.
