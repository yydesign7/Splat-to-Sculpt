# Fast Initializer Hierarchical Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build conservative two-level Fast Initializer layering for video/COLMAP and directly uploaded PLY inputs, automatically excluding only high-confidence background while preserving original point colors and forwarding named layers to Mesh Gen.

**Architecture:** A focused Python module owns robust spacing, background scoring, multi-scale object clustering, graph-based part segmentation, validation, and original-color export. The existing CLI and mask filter become adapters around that module; Next.js task routes publish the resulting URLs and metadata, and the workflow engine forwards them through `splat-output` to the existing per-layer Mesh Gen path.

**Tech Stack:** Python 3, NumPy, Open3D, Pillow, Next.js 16 App Router, React 19, TypeScript 5, Node test runner via `tsx`

## Global Constraints

- Use pnpm only for JavaScript package commands.
- `Auto layers` is the only UI control; no separate background-removal switch.
- `Auto layers = false` must bypass background removal and all segmentation.
- Background confidence must be at least `0.85` before automatic deletion.
- Video mask classification uses at least three visible views, foreground at `>= 0.60`, background at `<= 0.20`, and retains all intermediate evidence as unknown.
- Preserve original RGB in `foreground.ply` and final layer PLY files; palette colors belong only in `layers_debug.ply`.
- Direct PLY remains Fast Initializer-only; this plan does not layer True Training Gaussian primitives.
- Segmentation failures are non-fatal and must fall back to a usable Fast Initializer input.
- Support M-series macOS and Windows CUDA without learned-model downloads or new Python dependencies.
- Stop must terminate an active segmentation child process.

---

## File Map

- Create `scripts/pointcloud_layering.py`: reusable algorithm, configuration, validation, and export functions.
- Create `scripts/test_pointcloud_layering.py`: synthetic regression fixtures for cleanup, object layers, part layers, color preservation, naming, and accounting.
- Modify `scripts/pointcloud_segment.py`: thin CLI orchestration over `pointcloud_layering.py`, final JSON result, and optional prior background input.
- Modify `scripts/filter_pointcloud_by_masks.py`: conservative foreground/background/unknown mask voting and optional background PLY output.
- Modify `scripts/test_filter_pointcloud_by_masks.py`: three-state multi-view regression.
- Create `src/lib/layer-metadata.ts`: shared TypeScript task/node metadata contract.
- Create `src/lib/layer-metadata.test.ts`: parser and fallback contract tests.
- Modify `src/lib/pointcloud-task-store.ts`: publish background/debug/meta URLs and segmentation status.
- Modify `src/lib/gaussian-task-store.ts`: carry the same metadata into Gaussian task results.
- Modify `src/app/api/generate-pointcloud/route.ts`: run conservative mask filtering, invoke hierarchical segmentation, publish all artifacts, and preserve cancellation.
- Modify `src/app/api/generate-gaussian-splat/route.ts`: use the shared segmentation result for uploaded PLY and carry metadata through initializer results.
- Modify `src/lib/workflow-engine.ts`: forward layer metadata for both Gaussian output handles.
- Create `src/lib/workflow-engine.test.ts`: regression for `splat-output` metadata forwarding.
- Modify `src/components/flow/custom-nodes.tsx`: poll/store/reset new Gaussian metadata and retain the existing per-layer Mesh Gen behavior.
- Modify `src/components/flow/FlowEditor.tsx`: initialize and clear new node fields.
- Modify `src/lib/default-workflow.ts`: include empty metadata fields in the preset.
- Modify `AGENTS.md`: document the final Fast Initializer layering behavior and fields.

---

### Task 1: Robust Point-Cloud Preparation

**Files:**
- Create: `scripts/pointcloud_layering.py`
- Create: `scripts/test_pointcloud_layering.py`

**Interfaces:**
- Consumes: `open3d.geometry.PointCloud`, `LayeringConfig`
- Produces: `PreparedCloud`, characteristic spacing, full-resolution index mapping, and feature-availability metadata

Define these public interfaces:

```python
@dataclass(frozen=True)
class LayeringConfig:
    background_confidence_threshold: float = 0.85
    min_visible_views: int = 3
    foreground_ratio: float = 0.60
    background_ratio: float = 0.20
    working_point_limit: int = 200_000
    neighbor_count: int = 16
    max_parts_per_object: int = 8

@dataclass
class PreparedCloud:
    original: o3d.geometry.PointCloud
    working: o3d.geometry.PointCloud
    working_to_original: np.ndarray
    valid_original_indices: np.ndarray
    rejected_original_indices: np.ndarray
    spacing: float
    has_colors: bool

def estimate_characteristic_spacing(points: np.ndarray, neighbor_count: int = 8) -> float: ...
def prepare_cloud(pcd: o3d.geometry.PointCloud, config: LayeringConfig) -> PreparedCloud: ...
```

- [ ] **Step 1: Write failing preparation tests**

Add tests that create a dense unit cluster, one distant outlier, exact duplicates, and a thin circular structure. Assert that spacing remains close to the dense cluster spacing, invalid/duplicate accounting is explicit, the thin structure remains available, and a cloud over `working_point_limit` is downsampled without modifying `original`.

```python
def test_robust_spacing_ignores_distant_outlier() -> None:
    points = np.vstack([grid_points(step=0.02), np.array([[100.0, 100.0, 100.0]])])
    spacing = estimate_characteristic_spacing(points, neighbor_count=8)
    assert 0.015 <= spacing <= 0.05

def test_prepare_cloud_preserves_thin_continuous_structure() -> None:
    pcd = colored_cloud(ring_points(count=240), color=(0.7, 0.7, 0.7))
    prepared = prepare_cloud(pcd, LayeringConfig(working_point_limit=120))
    assert len(prepared.original.points) == 240
    assert len(prepared.working.points) <= 120
    assert prepared.valid_original_indices.size == 240
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `python3 scripts/test_pointcloud_layering.py --case preparation`

Expected: FAIL because `pointcloud_layering.py` or its public functions do not exist.

- [ ] **Step 3: Implement robust preparation**

Use an Open3D KD-tree to sample nearest-neighbor distances, take the median of finite positive distances, remove only non-finite and exact duplicate points, and voxel-downsample only the working cloud. Build `working_to_original` with nearest-neighbor lookup so later labels can be projected back.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `python3 scripts/test_pointcloud_layering.py --case preparation`

Expected: PASS with no warnings or unhandled Open3D errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/pointcloud_layering.py scripts/test_pointcloud_layering.py
git commit -m "feat: add robust point cloud preparation"
```

---

### Task 2: Conservative Background Classification

**Files:**
- Modify: `scripts/pointcloud_layering.py`
- Modify: `scripts/test_pointcloud_layering.py`
- Modify: `scripts/filter_pointcloud_by_masks.py`
- Modify: `scripts/test_filter_pointcloud_by_masks.py`

**Interfaces:**
- Consumes: `PreparedCloud`; for video input, COLMAP cameras plus per-frame masks
- Produces: high-confidence background indices, retained foreground/unknown indices, scores, reasons, and optional background PLY

Add these interfaces:

```python
@dataclass
class BackgroundDecision:
    foreground_indices: np.ndarray
    background_indices: np.ndarray
    confidence_by_candidate: list[dict[str, object]]
    status: str

def classify_direct_background(prepared: PreparedCloud, config: LayeringConfig) -> BackgroundDecision: ...

def classify_mask_votes(
    visible_counts: np.ndarray,
    foreground_counts: np.ndarray,
    min_visible_views: int = 3,
    foreground_ratio: float = 0.60,
    background_ratio: float = 0.20,
) -> np.ndarray:
    """Return 1=foreground, 0=background, 2=unknown; unknown is retained."""
```

Place `BackgroundDecision` and `classify_direct_background` in `pointcloud_layering.py`. Keep `classify_mask_votes` in `filter_pointcloud_by_masks.py`, where camera projections already produce the two vote arrays.

- [ ] **Step 1: Write failing direct-PLY background tests**

Create a broad support plane, a ring above it, and a remote sparse noise cluster. Assert that the plane reaches confidence `>= 0.85`, the ring is retained, the sparse cluster is background only when it is unstable across scales, and a flat product without a surrounding support plane is retained.

- [ ] **Step 2: Write failing mask-vote tests**

Extend the synthetic COLMAP fixture to create three points: one foreground in all views, one background in all views, and one foreground in only one of three views. Invoke the CLI with `--background-ply` and assert counts `foreground=1`, `background=1`, `unknown=1`, with foreground plus unknown written to the main output.

```python
labels = classify_mask_votes(
    visible_counts=np.array([3, 3, 3]),
    foreground_counts=np.array([3, 0, 1]),
)
assert labels.tolist() == [1, 0, 2]
```

- [ ] **Step 3: Run both tests and verify RED**

Run:

```bash
python3 scripts/test_pointcloud_layering.py --case background
python3 scripts/test_filter_pointcloud_by_masks.py
```

Expected: the first fails because direct background scoring is missing; the second fails because unknown points are currently discarded and no background PLY is produced.

- [ ] **Step 4: Implement direct background scoring**

Iteratively detect up to five RANSAC planes. Score each with normalized plane coverage, projected extent, plane thinness, normal agreement, and one-sided object support. Add remote-component candidates only when they remain detached at two or more DBSCAN radii. Delete only candidates whose final score is `>= config.background_confidence_threshold`; preserve candidates below that threshold.

- [ ] **Step 5: Implement conservative mask voting**

Replace the boolean `keep` calculation with `classify_mask_votes`. Add `--max-background-ratio` defaulting to `0.20` and optional `--background-ply`. Retain label `2` as unknown, write label `0` to the background file, preserve colors/normals in both outputs, and include the three counts in final JSON.

- [ ] **Step 6: Add rollback gates**

Rollback direct background deletion when retained points are empty, below 100, below one percent of valid input, or no stable component remains. Return the full cleaned cloud with status `partial-fallback` instead of raising.

- [ ] **Step 7: Run both tests and verify GREEN**

Run the two commands from Step 3.

Expected: both PASS; the mask test reports one foreground, one unknown, and one background point.

- [ ] **Step 8: Commit**

```bash
git add scripts/pointcloud_layering.py scripts/test_pointcloud_layering.py scripts/filter_pointcloud_by_masks.py scripts/test_filter_pointcloud_by_masks.py
git commit -m "feat: add conservative point cloud background removal"
```

---

### Task 3: Stable Level-One Object Segmentation

**Files:**
- Modify: `scripts/pointcloud_layering.py`
- Modify: `scripts/test_pointcloud_layering.py`

**Interfaces:**
- Consumes: retained working-cloud points and characteristic spacing
- Produces: one deterministic level-one object label per retained working point

Add:

```python
@dataclass
class ObjectSegmentation:
    labels: np.ndarray
    confidence_by_object: dict[int, float]
    merge_events: list[dict[str, object]]

def segment_objects(
    prepared: PreparedCloud,
    retained_working_indices: np.ndarray,
    config: LayeringConfig,
) -> ObjectSegmentation: ...
```

- [ ] **Step 1: Write failing multi-scale tests**

Build two dense separated objects plus three small fragments. Assert two stable objects, deterministic labels across repeated runs, nearest-compatible fragment merging, and a single `object_0` fallback for one continuous cloud.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `python3 scripts/test_pointcloud_layering.py --case objects`

Expected: FAIL because `segment_objects` does not exist.

- [ ] **Step 3: Implement three-scale DBSCAN consensus**

Derive a base radius from characteristic spacing; run DBSCAN at three neighboring multipliers. Use the middle-scale clusters as candidates, match low/high-scale clusters by point-overlap IoU, and keep candidates stable in at least two scales. Calculate minimum support from local density and total point count instead of a fixed global `min_points=20`.

- [ ] **Step 4: Implement fragment merging and fallback**

For each unstable fragment, select the nearest stable object only when normal and optional color agreement pass robust per-cloud thresholds. Otherwise retain it as a separate stable object if its cross-scale evidence is sufficient. If no candidate passes, emit label `0` for all retained points.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `python3 scripts/test_pointcloud_layering.py --case objects`

Expected: PASS and deterministic labels on two consecutive calls.

- [ ] **Step 6: Commit**

```bash
git add scripts/pointcloud_layering.py scripts/test_pointcloud_layering.py
git commit -m "feat: add stable object-level point cloud layers"
```

---

### Task 4: Level-Two Parts, Validation, and Original-Color Export

**Files:**
- Modify: `scripts/pointcloud_layering.py`
- Modify: `scripts/pointcloud_segment.py`
- Modify: `scripts/test_pointcloud_layering.py`

**Interfaces:**
- Consumes: prepared cloud, background decision, level-one labels, optional prior background PLY
- Produces: final part labels, deterministic names, `foreground.ply`, `background.ply`, layer PLY files, `layers_debug.ply`, `layers_meta.json`, and final CLI JSON

Add:

```python
@dataclass
class LayeringArtifacts:
    foreground_path: str
    background_path: str | None
    debug_path: str
    metadata_path: str
    layer_paths: list[str]
    layer_names: list[str]
    segmentation_status: str

def segment_parts(... ) -> np.ndarray: ...
def validate_partition(... ) -> None: ...
def export_artifacts(... ) -> LayeringArtifacts: ...
```

- [ ] **Step 1: Write failing part tests**

Create a torus-like ring body and attached stone with distinct color and curvature, a cylinder plus cap, a colorless continuous object, and an object with more than eight weak fragments. Assert multiple stable parts for the first two, one valid part for the colorless continuous object, at most eight parts after merging, and generic deterministic names.

- [ ] **Step 2: Write failing export/accounting tests**

Run the CLI in a temporary directory and assert:

```python
assert meta["foreground_point_count"] + meta["background_point_count"] + meta["rejected_point_count"] == meta["input_point_count"]
assert len(payload["layerFiles"]) == len(payload["layerNames"])
assert payload["layerNames"] == ["object_0_part_0", "object_0_part_1"]
assert original_layer_colors_are_preserved(layer_paths)
assert debug_palette_is_used_only(debug_path)
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `python3 scripts/test_pointcloud_layering.py --case parts --case export`

Expected: FAIL because graph parts and artifact export are missing.

- [ ] **Step 4: Implement part feature graph**

Estimate normals, covariance curvature, local density, and optional CIELAB color. Build a k-nearest-neighbor graph and normalize each feature by median/MAD. Use edge cost weights for distance, normal angle, curvature, Lab color, and density; set color weight to zero when color is absent. Join edges below the robust boundary threshold and form candidate regions.

- [ ] **Step 5: Implement conservative merges and the eight-part cap**

Keep a small region only when its boundary strength remains clearly above the object threshold. Merge weak small regions into the most compatible adjacent region. If more than eight parts remain, repeatedly merge the pair with the weakest separating boundary until eight remain.

- [ ] **Step 6: Implement validation and export**

Validate exclusive/full foreground assignment before writing. Preserve original RGB/normals in foreground/background/layer PLY files. Paint only `layers_debug.ply`. Write the full metadata contract and print one final JSON object containing `status`, artifact paths, `layerFiles`, `layerNames`, and `segmentationStatus`.

Update CLI arguments:

```text
--input
--output_ply
--layers_dir
--mode segment_all
--background_output <optional path>
--debug_output <optional path>
--prior_background <optional mask-filter background PLY>
--background_confidence 0.85
--max_parts_per_object 8
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `python3 scripts/test_pointcloud_layering.py --case parts --case export`

Expected: PASS with exact point accounting and preserved input RGB in non-debug outputs.

- [ ] **Step 8: Commit**

```bash
git add scripts/pointcloud_layering.py scripts/pointcloud_segment.py scripts/test_pointcloud_layering.py
git commit -m "feat: add hierarchical point cloud part layers"
```

---

### Task 5: Point-Cloud and Gaussian Task Integration

**Files:**
- Create: `src/lib/layer-metadata.ts`
- Modify: `src/lib/pointcloud-task-store.ts`
- Modify: `src/lib/gaussian-task-store.ts`
- Modify: `src/app/api/generate-pointcloud/route.ts`
- Modify: `src/app/api/generate-gaussian-splat/route.ts`

**Interfaces:**
- Consumes: final JSON from `filter_pointcloud_by_masks.py` and `pointcloud_segment.py`
- Produces: published ephemeral URLs and shared task metadata

Define the shared TypeScript contract:

```ts
export type SegmentationStatus =
  | 'skipped'
  | 'completed'
  | 'partial-fallback'
  | 'failed-fallback';

export interface LayerArtifactMetadata {
  backgroundPlyUrl?: string | null;
  layerDebugUrl?: string | null;
  layerMetaUrl?: string | null;
  layerFiles?: string[];
  layerNames?: string[];
  segmentationStatus?: SegmentationStatus;
  segmentationWarnings?: string[];
}
```

- [ ] **Step 1: Write a failing TypeScript metadata test**

Create a focused test in `src/lib/layer-metadata.test.ts` that parses a complete, partial-fallback, and malformed script payload. Expose:

```ts
export function parseLayerArtifactPayload(value: unknown): LayerArtifactMetadata;
```

Run: `pnpm exec tsx --test src/lib/layer-metadata.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the shared parser and task-store fields**

Reject mismatched `layerFiles`/`layerNames`, normalize warnings to strings, and return `failed-fallback` for malformed optional metadata without throwing away the primary PLY. Define the nested task result types as intersections with `LayerArtifactMetadata`, for example `result?: ({ splatUrl: string; sourcePlyUrl: string; gaussianCount: number; format: '3dgs-ply' } & LayerArtifactMetadata)`.

- [ ] **Step 3: Verify parser GREEN**

Run: `pnpm exec tsx --test src/lib/layer-metadata.test.ts`

Expected: PASS.

- [ ] **Step 4: Wire video/COLMAP output**

Change `filterPointCloudByMasks` to return foreground/background paths instead of one string. Pass mask background into `pointcloud_segment.py --prior_background`. Change `segmentPointCloud` to return parsed artifact metadata. Publish foreground, background, debug, metadata, and final layers under the point-cloud job directory.

In `runPointCloudStage`, send `enableForegroundMask: input.trainingMode === 'train' || input.enableSegmentation`. Inside the point-cloud route, invoke mask-based point deletion and hierarchical segmentation only when `enableSegmentation` is true. This gives the three required branches:

```text
Fast Initializer + Auto layers on  -> generate masks, filter points, segment
Fast Initializer + Auto layers off -> no masks, no point filtering, no segmentation
True Training                      -> generate/return masks for training, no hierarchical segmentation
```

When `enableSegmentation` is false, skip both mask-driven point deletion and hierarchical segmentation for the Fast Initializer source PLY and set `segmentationStatus: 'skipped'`. Preserve camera masks and original frames for True Training support.

- [ ] **Step 5: Wire directly uploaded PLY output**

Replace file-system probing in `segmentUploadedPointCloud` with the parsed CLI JSON contract. Use `foreground.ply` as `sourcePlyUrl`; publish optional background/debug/meta URLs; pass layers and status into `runGaussianInitializer`.

- [ ] **Step 6: Preserve non-fatal fallback and cancellation**

Register the segmentation PID in `trainingPid` before waiting and clear it in `finally`. On parsing, Open3D, or validation failure, pass the original/cleaned PLY into the initializer with `failed-fallback` plus warnings. Continue using `cancel-gaussian-splat` and `cancel-workflow-tasks` to terminate the registered process tree.

- [ ] **Step 7: Run TypeScript and Python integration checks**

Run:

```bash
python3 scripts/test_filter_pointcloud_by_masks.py
python3 scripts/test_pointcloud_layering.py
pnpm exec tsx --test src/lib/layer-metadata.test.ts
pnpm ts-check
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/layer-metadata.ts src/lib/layer-metadata.test.ts src/lib/pointcloud-task-store.ts src/lib/gaussian-task-store.ts src/app/api/generate-pointcloud/route.ts src/app/api/generate-gaussian-splat/route.ts
git commit -m "feat: publish hierarchical point cloud layer metadata"
```

---

### Task 6: Workflow and Node Metadata Propagation

**Files:**
- Modify: `src/lib/workflow-engine.ts`
- Create: `src/lib/workflow-engine.test.ts`
- Modify: `src/components/flow/custom-nodes.tsx`
- Modify: `src/components/flow/FlowEditor.tsx`
- Modify: `src/lib/default-workflow.ts`

**Interfaces:**
- Consumes: `LayerArtifactMetadata` from Gaussian task results
- Produces: Mesh Gen inputs and clearable Gaussian node state

- [ ] **Step 1: Write failing workflow forwarding tests**

Export a narrow test seam for computing a target update, or test `computeDownstreamPushes` with a Gaussian node whose `splatUrl` is connected to `modelGeneration.model-input`. Assert:

```ts
assert.deepEqual(targetUpdate, {
  modelUrl: '/gaussian_splat.ply',
  inputType: 'splat',
  layerFiles: ['/layers/object_0_part_0.ply'],
  layerNames: ['object_0_part_0'],
  backgroundPlyUrl: '/background.ply',
  layerDebugUrl: '/layers_debug.ply',
  layerMetaUrl: '/layers_meta.json',
  segmentationStatus: 'completed',
  segmentationWarnings: [],
});
```

Also test `mesh-output` and the absence of optional metadata.

- [ ] **Step 2: Run workflow test and verify RED**

Run: `pnpm exec tsx --test src/lib/workflow-engine.test.ts`

Expected: FAIL because `splat-output` currently drops layer fields.

- [ ] **Step 3: Forward metadata for both Gaussian outputs**

Keep `inputType` inference unchanged, but copy `layerFiles`, `layerNames`, `backgroundPlyUrl`, `layerDebugUrl`, `layerMetaUrl`, and `segmentationStatus` whenever the Gaussian source provides them. Do not gate layer forwarding on `isPly`.

- [ ] **Step 4: Run workflow test and verify GREEN**

Run: `pnpm exec tsx --test src/lib/workflow-engine.test.ts`

Expected: PASS for both handles.

- [ ] **Step 5: Extend Gaussian node polling/state**

Extend `GaussianSplatNodeData` and `waitForGaussianTask` result types with `LayerArtifactMetadata`. Store the fields when a task completes. On preview-file clear and global Clear, reset URLs to `null`, arrays to `[]`, status to `undefined`/`'skipped'` as appropriate, and remove stale warnings.

- [ ] **Step 6: Keep Mesh Gen per-layer behavior mode-independent**

Change `useLayerPlys` to rely on valid `layerFiles` plus GLB output rather than the primary `inputType`. The primary input may be `splat`, but final part files are ordinary PLY. Preserve the existing loop that generates one GLB per layer, merges named GLBs, and writes `layerGlbUrls`.

```ts
const useLayerPlys =
  (data.layerFiles?.length ?? 0) > 0 &&
  data.layerFiles?.length === data.layerNames?.length &&
  requestedOutputFormat === 'glb';
```

- [ ] **Step 7: Update initial/default data and verify**

Add `backgroundPlyUrl: null`, `layerDebugUrl: null`, `layerMetaUrl: null`, `segmentationStatus: undefined`, and `segmentationWarnings: []` to Gaussian initial/default data and Clear reset blocks.

Run:

```bash
pnpm exec tsx --test src/lib/workflow-engine.test.ts
pnpm ts-check
pnpm lint
```

Expected: all commands exit 0 with no new warnings.

- [ ] **Step 8: Commit**

```bash
git add src/lib/workflow-engine.ts src/lib/workflow-engine.test.ts src/components/flow/custom-nodes.tsx src/components/flow/FlowEditor.tsx src/lib/default-workflow.ts
git commit -m "feat: forward hierarchical layers through splat workflow"
```

---

### Task 7: Full Regression, Browser Smoke Test, and Documentation

**Files:**
- Modify: `AGENTS.md`
- Verify: all files changed in Tasks 1-6

**Interfaces:**
- Consumes: completed hierarchical Fast Initializer implementation
- Produces: cross-platform regression evidence and current project documentation

- [ ] **Step 1: Run all focused Python tests**

```bash
python3 scripts/test_foreground_masks.py
python3 scripts/test_filter_pointcloud_by_masks.py
python3 scripts/test_pointcloud_layering.py
```

Expected: all exit 0.

- [ ] **Step 2: Compile changed Python files**

```bash
python3 -m py_compile scripts/pointcloud_layering.py scripts/pointcloud_segment.py scripts/filter_pointcloud_by_masks.py scripts/test_pointcloud_layering.py scripts/test_filter_pointcloud_by_masks.py
```

Expected: exit 0 and no syntax errors.

- [ ] **Step 3: Run all focused TypeScript tests**

```bash
pnpm exec tsx --test src/lib/layer-metadata.test.ts src/lib/workflow-engine.test.ts src/lib/asset-download.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Run project checks**

```bash
pnpm ts-check
pnpm lint
```

Expected: both exit 0.

- [ ] **Step 5: Run direct PLY browser smoke test**

With `Auto layers` on, upload `/Users/yuyi/projects/.data/ephemeral/11efc3f8-0052-4b42-b2cc-68e3191edefd/pointclouds/fe37d8cf-3a05-4430-ad6d-29d5a6ad478f/output.ply`, run the workflow, and verify that Gaussian Splat Gen completes, Mesh Gen receives more than one layer when stable boundaries exist, and Surface Processing shows the same generic layer names. Confirm that the main preview preserves original colors. If this ignored local fixture has been cleaned before execution, first regenerate an equivalent point-cloud fixture from the video in Step 6 and record the replacement absolute path in the verification notes.

- [ ] **Step 6: Run video/COLMAP browser smoke test**

Upload `/Users/yuyi/projects/public/asset-published/asset_1784065145460_4yy7h6/input.mp4` and run it through Fast Initializer. Verify uncertain mask points are retained, high-confidence background is absent from `foreground.ply`, the background artifact exists, and Stop terminates segmentation if clicked during that stage.

- [ ] **Step 7: Verify Auto layers bypass**

Turn `Auto layers` off and run the same direct PLY fixture. Confirm no segmentation progress stage appears, no layer/background/meta URLs are produced, and the original PLY is used by Fast Initializer.

- [ ] **Step 8: Update project context**

Update `AGENTS.md` to state that Auto layers controls both conservative background removal and two-level Fast Initializer layering, list the new metadata fields, and explicitly exclude True Training primitive layering.

- [ ] **Step 9: Inspect repository diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended implementation/test/documentation files are part of this feature.

- [ ] **Step 10: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document hierarchical fast initializer layers"
```

---

## Completion Checklist

- [ ] Both Fast Initializer input paths use the approved conservative two-level design.
- [ ] `Auto layers` alone controls background removal and layering.
- [ ] Original RGB is preserved in reconstruction and final part PLY files.
- [ ] Only background candidates at confidence `>= 0.85` are automatically excluded.
- [ ] Unknown video-mask evidence is retained.
- [ ] Every foreground point maps to exactly one final part.
- [ ] Generic names are deterministic and reach Surface Processing.
- [ ] `splat-output` forwards all layer metadata.
- [ ] Stop kills segmentation; failures return usable fallback output.
- [ ] Python tests, TypeScript tests, `pnpm ts-check`, `pnpm lint`, and both browser smoke tests pass.
