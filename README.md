# Splat to Sculpt

[中文](README.zh-CN.md) | English

Splat to Sculpt is a local-first, node-based web workflow for turning captured video or point-cloud input into editable 3D assets and presentation videos. It connects frame extraction, COLMAP reconstruction, Gaussian Splat generation, mesh conversion, Blender processing, asset management, ComfyUI video generation, and preview/export tools in one browser canvas.

The project is built with Next.js 16, React 19, TypeScript, React Flow, Three.js, shadcn/ui, and Python processing scripts. Heavy reconstruction and rendering work is run locally through FFmpeg, COLMAP, Blender, Python, and optionally ComfyUI.

## Current Workflow

The built-in default workflow is:

```text
Video Upload
  -> Frame Extraction
  -> Gaussian Splat Gen
  -> Mesh Gen
  -> Model Cleanup
  -> Surface Processing
  -> ComfyUI Video Gen
  -> Video Preview
```

Users can also drag assets from the sidebar into compatible nodes, save custom workflows, stop long-running tasks, clear previews, and reuse generated models or videos from the Assets panel.

Workflow execution is centralized in `src/lib/workflow/`: a typed node registry defines ports, readiness, completion, data transfer, reset behavior, and node executors; a graph compiler validates saved or edited DAGs; and a run-scoped scheduler/runner owns start order, propagation, cancellation, stale-result protection, and automatic completion. React node components now stay focused on upload controls, previews, local editing UI, and asset publication side effects.

## Main Features

- Node-based visual workflow editor with clickable, removable connections.
- Video upload with frame extraction through FFmpeg.
- COLMAP sparse reconstruction, dense matching, stereo fusion, and foreground mask support for point-cloud generation.
- Gaussian Splat generation with automatic CUDA / MPS / CPU route selection and optional true-training mode.
- Direct PLY upload support for fast initializer workflows.
- Mesh Gen conversion from PLY/splat/model input to downstream model formats.
- Mesh-level `geometry_graph_surface` segmentation after reconstruction, capped to practical layer counts.
- Per-layer GLB output for editing, plus merged layered GLB publishing to Assets.
- Model Cleanup and Surface Processing through local Blender.
- ComfyUI Video Gen integration for model-to-multiview-to-video workflows.
- Seedance ComfyUI pack detection and install helper for required custom nodes/workflows.
- Assets sidebar for uploaded videos, splats, Mesh Gen models, merged layered GLBs, and rendered videos.
- Model and video thumbnail generation for easier browsing.
- Session-based temporary file storage with automatic cleanup.

## Quick Start

This project uses `pnpm`. Do not use `npm` or `yarn`.

Run the guided setup checker for your platform. It installs the locked pnpm dependencies, reports missing local tools, and leaves large external applications and AI models under your control.

macOS:

```bash
bash scripts/setup-macos.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1
```

Add `--install-python` on macOS or `-InstallPython` on Windows to install the Python processing packages. Add `--check-only` or `-CheckOnly` to perform diagnostics without installing project dependencies.

Manual setup remains available:

Install dependencies:

```bash
pnpm install
```

Install Python processing dependencies when you need reconstruction, mesh, thumbnail, or video scripts:

```bash
pnpm python-deps
```

Start the development server:

```bash
pnpm dev
```

Open [http://localhost:5001](http://localhost:5001).

Build and run the production server:

```bash
pnpm build
pnpm start
```

## Local Tool Requirements

Basic UI work can run with Node.js and pnpm only. The full reconstruction workflow also depends on local tools:

- FFmpeg: video probing and frame extraction.
- COLMAP: camera poses, sparse reconstruction, dense matching, and stereo fusion.
- Python packages listed in `scripts/requirements-python.txt`.
- Blender: model cleanup, material/surface processing, previews, and rotation-video rendering.
- ComfyUI: optional final video generation through the ComfyUI API.

The development script tries to use the configured Python environment and local tool paths when available. You can override paths with environment variables such as:

```bash
PYTHON_BIN=/path/to/python
NS_TRAIN_BIN=/path/to/ns-train
NS_EXPORT_BIN=/path/to/ns-export
COMFYUI_BASE_URL=http://127.0.0.1:8000
COMFYUI_3D_INPUT_DIR=/path/to/ComfyUI/input/3d
```

## ComfyUI Integration

The ComfyUI Video Gen node talks to a local ComfyUI server, defaulting to:

```text
http://127.0.0.1:8000
```

At runtime the backend:

1. Checks whether ComfyUI is online.
2. Detects ComfyUI input, output, `input/3d`, custom node, and workflow directories from `/system_stats`.
3. Copies the final model into ComfyUI `input/3d`.
4. Builds a prompt from the bundled API workflow preset.
5. Submits the prompt through `/prompt`.
6. Polls `/history/{prompt_id}`.
7. Downloads the generated video through `/view`.
8. Returns the video to the web page and publishes it to Assets.

The project includes a Seedance deployment package under:

```text
vendor/comfyui/seedance2/
```

It contains the required custom nodes and workflow files used by the ComfyUI Video Gen preset. The app can check whether the pack is installed and copy the files into the detected ComfyUI folders.

## Blender Integration

Blender is called locally in background mode for:

- Model Cleanup.
- Surface Processing material and light output.
- Layer-aware model processing.
- Static preview rendering.
- Rotation video rendering when Video Preview receives a model.

If Blender is missing, Blender-dependent nodes show a clear error while earlier workflow steps remain usable.

## Assets And Temporary Files

The app separates temporary workflow files from reusable assets:

- Temporary session files are written to `.data/ephemeral/{sessionId}/`.
- Published assets are copied to `public/asset-published/{assetId}/`.
- Asset metadata is stored in `public/asset-library/assets.json`.

Sidebar Assets show reusable files only, such as uploaded videos, Gaussian splat PLY files, Mesh Gen model outputs, merged layered GLBs, ComfyUI videos, and rotation videos. Intermediate frames, masks, COLMAP workspaces, raw layer GLBs, and metadata files stay temporary.

Cleanup behaviour:

- On backend startup, session folders older than 3 days are removed.
- On normal backend exit, `.data/ephemeral` is cleared.
- Published Assets are not deleted by ephemeral cleanup.

## Mesh And Layer Publishing

Mesh Gen registers generated `glb`, `obj`, and `fbx` model outputs to Assets. When Mesh Gen produces `layerGlbUrls`, the app first merges the layer GLBs into one `merged.glb` with layer names preserved as internal nodes/objects, then publishes that single layered GLB to Assets. Individual layer GLBs remain temporary and are used for Surface Processing.

## Useful Scripts

```bash
pnpm dev          # Start the local development server
pnpm build        # Build the production application
pnpm start        # Start the production server
pnpm ts-check     # Run TypeScript type checking
pnpm lint         # Run ESLint
pnpm python-deps  # Install Python script dependencies
```

## Project Structure

```text
src/
├── app/                 # Next.js App Router pages and API routes
├── components/flow/     # Workflow canvas, node UI, viewers, and sidebar
├── components/ui/       # shadcn/ui base components
├── hooks/               # Shared React hooks, including the React workflow-runner adapter
├── lib/                 # Workflow registry/runner, task stores, publishing helpers
│   └── workflow/        # Typed contracts, registry, compiler, scheduler, executors

scripts/
├── setup-macos.sh
├── setup-windows.ps1
├── generate_gaussian_splat.py
├── train_gaussian_splat.py
├── gs_to_mesh.py
├── merge_glbs.py
├── render_ply_thumbnail.py
├── render_model_thumbnail.py
└── other model/video/reconstruction scripts

vendor/
└── comfyui/seedance2/   # Optional ComfyUI Seedance deployment pack

public/
├── asset-library/       # Lightweight asset metadata
└── workflow-library/    # Saved workflow metadata
```

## Generated Files

Runtime assets and local generated output should stay out of Git. Ignored paths include:

```text
.data/
public/asset-published/
public/videos/
public/frames/
public/uploads/
public/colmap-scenes/
public/blender-output/
public/rotation-videos/
scripts/.mamba-root/
```

Fresh clones start with empty local Assets. Large demo assets should be distributed through Releases, cloud storage, or dataset hosting instead of the source repository.

## Validation

Common checks:

```bash
pnpm ts-check
pnpm lint
```

Feature-specific tests can be run with `tsx`, for example:

```bash
pnpm exec tsx --test src/lib/mesh-asset-publish-policy.test.ts
pnpm exec tsx --test src/lib/ephemeral-cleanup.test.ts
```
