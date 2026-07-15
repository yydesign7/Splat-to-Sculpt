# Fast Initializer Foreground Mask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply rembg masks to every Fast initializer reconstruction stage and remove fused 3D points that fail multi-view foreground-mask consistency.

**Architecture:** `generate_foreground_masks.py` produces both masks and black-background RGB working frames. A focused `filter_pointcloud_by_masks.py` utility reads a COLMAP text model, projects PLY vertices into registered views, and writes a filtered PLY; the point-cloud API invokes it as a non-fatal post-process.

**Tech Stack:** Python 3, NumPy, Pillow, Open3D, COLMAP 3.11, Next.js 16, TypeScript 5

## Global Constraints

- Use pnpm only for JavaScript package commands.
- Preserve original frames for True training.
- Keep mask and image stems identical.
- Mask and point filtering failures must remain non-fatal.

---

### Task 1: Masked RGB Working Frames

**Files:**
- Modify: `scripts/generate_foreground_masks.py`
- Modify: `scripts/test_foreground_masks.py`

**Interfaces:**
- Consumes: `--images-dir`, `--masks-dir`, optional `--masked-images-dir`
- Produces: binary PNG masks and same-named RGB images with zeroed background pixels

- [ ] Add a regression assertion that requests `--masked-images-dir` and expects black background plus preserved foreground RGB.
- [ ] Run `python3 scripts/test_foreground_masks.py` and confirm it fails because the argument is missing.
- [ ] Add masked RGB emission after each validated mask is generated.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Multi-view Point Filter

**Files:**
- Create: `scripts/filter_pointcloud_by_masks.py`
- Create: `scripts/test_filter_pointcloud_by_masks.py`

**Interfaces:**
- Consumes: input PLY, output PLY, COLMAP text model, and per-image PNG masks
- Produces: JSON metrics and a PLY containing points with sufficient foreground support

- [ ] Create a synthetic three-camera regression test with one foreground and one background point.
- [ ] Run the test and confirm it fails because the filter script is missing.
- [ ] Implement COLMAP text parsing, camera projection, mask voting, Open3D PLY IO, and acceptance gates.
- [ ] Re-run the focused test and confirm it passes.

### Task 3: Point-cloud Pipeline Wiring

**Files:**
- Modify: `src/app/api/generate-pointcloud/route.ts`

**Interfaces:**
- Consumes: generated mask metrics, masked working image directory, sparse camera model, fused or sparse PLY
- Produces: foreground-filtered PLY with automatic fallback to the unfiltered reconstruction

- [ ] Track `sourceImagesDir` separately from the active COLMAP image directory.
- [ ] Pass `--masked-images-dir` to mask generation and use it only after mask validation.
- [ ] Keep feature extraction and mapping on original images for robust low-texture camera poses; route undistortion, dense matching, and depth estimation through masked working images.
- [ ] Convert the sparse camera model to text and invoke the point filter after dense, sparse fallback, and optional depth fusion.
- [ ] Preserve original `colmapImagesDir` and existing mask metadata for True training.

### Task 4: Verification

**Files:**
- Verify all changed Python and TypeScript files

**Interfaces:**
- Consumes: completed implementation
- Produces: regression evidence

- [ ] Run both focused Python regression scripts.
- [ ] Run Python bytecode compilation for all changed scripts.
- [ ] Run `pnpm ts-check`.
- [ ] Run `pnpm lint` and report pre-existing warnings separately from errors.
