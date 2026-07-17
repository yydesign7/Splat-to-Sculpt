# Fast Initializer Hierarchical Layering Design

## Status

Approved on 2026-07-18.

## Goal

Improve Fast Initializer point-cloud layering so it can conservatively remove background, separate independent objects, and divide each object into useful geometric or appearance-based parts. The design must support both video/COLMAP reconstruction and directly uploaded PLY files without introducing a second UI control.

## Non-Goals

- Semantic names such as `ring_band`, `gemstone`, or `bottle_cap`.
- Layering trained Gaussian primitives produced by True Training.
- Requiring a large learned 3D segmentation model.
- Guaranteeing multiple parts when the input contains no stable geometric or appearance boundary.

## Control Contract

`Auto layers` is the only control for this feature.

- When enabled, the Fast Initializer path runs input cleanup, conservative background separation, level-one object segmentation, level-two part segmentation, validation, and metadata export.
- When disabled, all background removal and layering steps are skipped. The original PLY proceeds to Fast Initializer without segmentation-derived replacement files or metadata.
- Direct PLY input remains forced to Fast Initializer and never attempts True Training.
- True Training keeps its existing camera/mask path and is outside this design's final-Gaussian layering scope.

## Unified Pipeline

```text
Auto layers off
  input PLY -> Fast Initializer

Auto layers on
  input adapter
  -> robust cleanup
  -> conservative background separation
  -> level-one object segmentation
  -> level-two part segmentation
  -> validation and fragment merging
  -> foreground PLY -> Fast Initializer
                     -> layer PLY metadata -> Mesh Gen
```

Video/COLMAP and direct PLY inputs share the segmentation output contract but use different evidence during background separation.

## Output Contract

The segmentation stage produces:

- `foreground.ply`: all retained object points with their original RGB values. This is the source PLY used by Fast Initializer.
- `background.ply`: high-confidence removed background points with original RGB values. It is retained for recovery and diagnostics but is not sent to Mesh Gen.
- `layers/object_<object-index>_part_<part-index>.ply`: one original-color PLY per final part.
- `layers_debug.ply`: a palette-colored merged preview used only for visual inspection.
- `layers_meta.json`: hierarchy, point counts, confidence, bounding boxes, feature availability, merge decisions, and background-removal reasons.

The main reconstruction input must not be painted with layer palette colors. Overwriting original RGB harms Fast Initializer color quality. Palette colors are limited to `layers_debug.ply`.

## Input Cleanup

Segmentation runs on a working copy while labels are mapped back to the full-resolution point cloud.

1. Remove non-finite points and exact duplicates.
2. Estimate characteristic spacing from the median k-nearest-neighbor distance. Do not scale thresholds only from the global bounding-box diagonal because distant outliers distort it.
3. Create a voxel-downsampled working cloud for expensive clustering when the input exceeds the configured working-point limit.
4. Mark a point as an outlier only when it is both locally under-supported and spatially separated from a stable component.
5. Map final labels to the original-resolution points using nearest-neighbor correspondence.

Thin but locally continuous structures are retained even when they contain relatively few points.

## Conservative Background Separation

### Video/COLMAP Input

Use the existing original frames, rembg masks, registered cameras, and multi-view projection data.

For each reconstructed point:

- Require at least three valid visible views before making a background decision.
- Mark the point as foreground when at least 60 percent of valid views classify it as foreground.
- Mark the point as background only when no more than 20 percent of valid views classify it as foreground, equivalent to at least 80 percent background agreement.
- Mark all other points as `unknown` and retain them in the foreground output.

This conservative classification supersedes any behavior that automatically deletes every point below the 60 percent foreground threshold when `Auto layers` is enabled. Mask generation and camera projection remain non-fatal.

After mask voting, geometric support-plane and remote-component checks may add background points only when their confidence passes the common deletion threshold.

### Direct PLY Input

Direct PLY input has no camera evidence, so background confidence combines geometry, topology, density, and optional color.

1. Detect several RANSAC plane candidates rather than accepting the first horizontal plane.
2. Score each candidate using projected area, thickness, boundary position, normal consistency, and the proportion of stable object points lying on one side.
3. Do not assume the input uses a Z-up coordinate system.
4. Identify remote low-density components only when they are separated from the dominant stable components across multiple clustering scales.
5. Use color uniformity as supporting evidence only; color alone cannot delete a region.

Only candidates with background confidence of at least `0.85` are excluded. Lower-confidence candidates remain in `foreground.ply`.

### Background Rollback

Background deletion is rolled back when any of the following occurs:

- The retained cloud is empty, contains fewer than 100 points, or is below one percent of the valid input.
- Removal destroys every stable level-one component.
- Removed points substantially overlap thin, locally continuous structures.
- Point accounting or label mapping fails validation.

Rollback is non-fatal and continues with the cleaned but unsegmented input.

## Level-One Object Segmentation

Level one separates independent objects and uses stable multi-scale spatial clustering.

1. Derive a base radius from median nearest-neighbor spacing.
2. Run DBSCAN at three neighboring radii around that base value.
3. Match clusters between scales by point overlap.
4. Keep an independent object only when it remains stable at more than one scale.
5. Merge small unstable fragments into the nearest compatible object using distance, normal agreement, and optional color agreement.
6. If no stable split exists, emit a single `object_0` instead of treating segmentation as an error.

The result must not depend on a fixed `min_points=20` for all cloud sizes. Minimum support is calculated from both local density and total point count, with a small absolute floor.

## Level-Two Part Segmentation

Level two operates independently inside each level-one object.

1. Estimate normals and local covariance eigenvalues.
2. Compute local curvature from the covariance spectrum.
3. Convert available sRGB color to CIELAB using a local NumPy implementation; no additional image-processing dependency is required.
4. Build a k-nearest-neighbor graph.
5. Weight each graph edge using normalized spatial distance, normal-angle difference, curvature change, Lab color difference, and local density change.
6. Cut only statistically strong boundaries using robust per-object feature distributions.
7. Form candidate parts through graph region growing.
8. Merge weakly separated or undersupported regions into the most compatible neighbor.

Small regions are not deleted solely because of point count. A small region remains a part when it has a strong, stable color or geometric boundary. Otherwise it is merged. Each object exposes at most eight final parts by default; excess weak regions are merged by boundary similarity.

When color is absent, its edge weight becomes zero and the metadata records lower evidence coverage. If no stable part boundary exists, the object emits one part.

## Naming and Metadata

Names are deterministic and generic:

- Level one: `object_0`, `object_1`, and so on.
- Final parts: `object_0_part_0`, `object_0_part_1`, and so on.

`layers_meta.json` records at least:

- algorithm version and `Auto layers` state;
- input feature availability;
- foreground and background point counts;
- background candidates, scores, and reasons;
- object/part parent relationships;
- per-part point count, bounding box, and confidence;
- fragment merge decisions;
- validation and fallback status.

## Downstream Data Flow

Gaussian Splat Gen exposes:

```text
sourcePlyUrl       = foreground.ply
splatUrl           = whole Fast Initializer splat
backgroundPlyUrl   = recoverable background.ply when present
layerFiles         = final part PLY URLs
layerNames         = deterministic final part names
layerMetaUrl       = layers_meta.json
segmentationStatus = skipped | completed | partial-fallback | failed-fallback
```

The workflow engine must forward layer metadata from Gaussian Splat Gen to Mesh Gen for both `mesh-output` and `splat-output`. The current `modelGeneration.model-input` mapping conditionally forwards layers only when the Gaussian output is treated as ordinary PLY; that condition must be removed while retaining type inference for the primary model URL.

Mesh Gen converts each `layerFiles` entry to an individual GLB, merges the GLBs with `layerNames` as mesh names, stores the individual URLs in `layerGlbUrls`, and forwards the hierarchy through Model Cleanup and Surface Processing.

Because Fast Initializer does not optimize, split, clone, or prune points, source point membership remains valid for this layered Mesh Gen path. This statement does not apply to True Training output.

## Error Handling and Cancellation

- Segmentation failure never fails the complete Gaussian Splat task.
- Background failure keeps the cleaned input.
- Level-one failure emits `object_0`.
- Level-two failure emits one part per level-one object.
- Open3D or optional feature failure returns `failed-fallback` and uses the original PLY.
- Empty layer files, duplicate point assignments, missing point assignments, or inconsistent metadata trigger rollback.
- Stop must terminate the currently registered segmentation child process using the same cancellation path as other Gaussian subprocesses.
- Warnings and fallback reasons are returned in task metadata and logs without replacing a successful Fast Initializer status with an error.

## Performance

- Expensive normal, curvature, graph, and multi-scale clustering work runs on a bounded downsampled cloud.
- Full-resolution points are labeled only after the working-cloud result is accepted.
- Spatial searches use Open3D KD-trees or vectorized NumPy operations.
- The implementation avoids heavyweight learned-model downloads and remains compatible with M-series macOS and Windows CUDA environments.

## Validation Rules

Before accepting segmented output:

1. Every valid input point is accounted for as foreground, background, or explicitly rejected input cleanup.
2. Every foreground point belongs to exactly one final part.
3. No final part is empty.
4. `layerFiles.length` equals `layerNames.length` and metadata final-part count.
5. The union of final parts equals `foreground.ply` within point-mapping tolerance.
6. Background confidence is at least `0.85` for every automatically excluded background region.

## Test Plan

### Unit and Synthetic Tests

- Robust spacing is not distorted by distant outliers.
- A broad support plane and two disconnected objects produce one background and two level-one objects.
- A ring-like thin structure survives outlier cleanup and background deletion.
- A ring body plus a color/curvature-distinct stone produces multiple level-two parts.
- A cosmetic-style cylinder plus cap produces stable object parts.
- Colorless PLY input runs geometry-only and records reduced evidence coverage.
- A single continuous object with no stable boundary returns one valid part.
- Point accounting, deterministic naming, maximum-part merging, and metadata counts are exact.
- Disabling `Auto layers` bypasses segmentation and returns no segmentation-derived layers.

### Pipeline Tests

- Video/COLMAP mask voting retains uncertain points and removes only high-confidence background.
- Direct PLY segmentation feeds `foreground.ply` into Fast Initializer.
- Layer metadata travels through `splat-output` into Mesh Gen.
- Mesh Gen produces one GLB per final layer and a merged GLB with named meshes.
- Model Cleanup and Surface Processing receive matching `layerNames` and `layerGlbUrls`.
- Segmentation errors fall back without failing the workflow.
- Stop terminates an active segmentation process.

### Acceptance Targets

- Foreground object-point retention is at least 98 percent on the maintained evaluation fixtures.
- No background region with confidence below `0.85` is automatically deleted.
- Actual ring, jewelry, and cosmetic fixtures are evaluated in addition to synthetic clouds.
- TypeScript checking, ESLint, Python syntax checks, targeted Python tests, and the browser workflow smoke test pass.

## Implementation Boundaries

Expected changes remain focused on:

- `scripts/pointcloud_segment.py` and targeted Python tests;
- Fast Initializer point-cloud/mask filtering helpers;
- `src/app/api/generate-gaussian-splat/route.ts` output and fallback metadata;
- `src/lib/workflow-engine.ts` layer forwarding for `splat-output`;
- Mesh Gen metadata consumption where required;
- Gaussian Splat Gen status text only if needed to expose non-fatal fallback.

No True Training primitive-layering implementation or semantic model integration is included.
