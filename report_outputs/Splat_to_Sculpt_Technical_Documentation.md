# Splat to Sculpt

## Technical Documentation

**Document type:** Development handover and maintenance reference  
**Project:** Splat to Sculpt  
**Prepared by:** Yu Yi  
**Version:** 1.0.0  
**Version basis:** GitHub Release `v1.0.0`, commit `5f6e35f`, 3 August 2026  

---

## Document Conventions

This document describes the implemented system rather than an aspirational design. Node labels, API paths, data fields and file locations are written exactly as they appear in the current application. Commands assume the repository root as the working directory. Paths beginning with `/api/` are application routes; paths beginning with `.data/` or `public/` are local filesystem locations relative to the repository root. Portable examples use placeholders such as `<repository-root>` and `<comfyui-data-root>` instead of machine-specific home-directory paths.

The core module descriptions use a consistent maintenance pattern: purpose, input, processing, output, failure handling and key files. The document is intended to let a new developer install the project, follow a workflow run, identify which process owns an output and extend a node without first reverse-engineering the whole codebase.

# 1. Overview

## 1.1 Purpose

Splat to Sculpt is a local-first, node-based web application for converting captured video or an existing point cloud into reusable 3D assets and presentation videos. It combines browser-based workflow editing with local reconstruction and content-creation tools. The web interface coordinates the work, while compute-heavy operations are delegated to FFmpeg, COLMAP, Python, Nerfstudio, Blender and ComfyUI.

This technical document serves four purposes. First, it records the implemented architecture and the data contracts between workflow nodes. Second, it explains how reconstruction, mesh processing and local-tool integration are executed. Third, it provides an API, storage and deployment reference for development handover. Finally, it records known failure modes and the checks required before a change is considered safe.

The document does not describe a conventional hosted SaaS backend. There is no required application database, user authentication service or remote AI provider in the primary workflow. Runtime state is held in browser node data, lightweight JSON libraries, in-memory task stores and local files. ComfyUI may call model services configured by the user's own ComfyUI workflow, but the Splat to Sculpt application itself communicates with a local ComfyUI server.

## 1.2 Project Scope

The system accepts two principal input routes:

- A video is uploaded, sampled into still frames and reconstructed through COLMAP before Gaussian Splat and mesh processing.
- A PLY point cloud is uploaded directly and converted into an initializer-style Gaussian field before mesh processing.

The output side covers mesh reconstruction, defect-oriented cleanup, geometry-based layer generation, Blender cleanup, per-layer material and lighting adjustment, ComfyUI model-to-video generation and final video preview. Reusable outputs are registered in the Assets sidebar. Intermediate artefacts remain isolated within a workflow session and are automatically removed according to the temporary-file policy.

The system is designed for local creative and research workflows rather than unattended cloud execution. It assumes that the browser and the Next.js backend run on the same machine as the required desktop tools. The current implementation is therefore well suited to a development workstation, but it is not hardened as a public multi-user service.

## 1.3 Current Default Workflow

The built-in Default Workflow contains the following processing chain:

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

`Surface Processing` connects directly to `ComfyUI Video Gen`; there is no second Mesh Gen node after surface processing. Three Sticky Note nodes are included as non-processing annotations. `Material Gen` remains available in the Node Library for compatibility and experimentation, but its generation API is currently disabled and it is not part of the default workflow.

The normal run starts after the user uploads a video and presses Run. Completed nodes push data only across existing edges. A node does not broadcast its output to every compatible node on the canvas. This keeps custom workflows predictable and makes disconnected nodes safe to leave in the workspace.

## 1.4 Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Web framework | Next.js 16 App Router | Page rendering, local API routes and production server |
| UI runtime | React 19 and TypeScript 5 | Typed component and node-state implementation |
| Workflow canvas | React Flow 12 (`@xyflow/react`) | Nodes, handles, edges, viewport controls and hit testing |
| UI system | Tailwind CSS 4, shadcn/ui and Radix UI | Layout, controls, dialogs, tooltips and accessible primitives |
| 3D preview | Three.js, React Three Fiber and Drei | GLB/GLTF, PLY and Gaussian-oriented previews |
| Video processing | FFmpeg and FFprobe | Video inspection, frame extraction and encoded previews |
| Camera reconstruction | COLMAP | Feature extraction, matching, SfM, camera poses, dense stereo and fusion |
| Gaussian processing | Python, Nerfstudio and gsplat-compatible tools | Fast initializer export and optional True training |
| Mesh processing | Open3D, NumPy and Trimesh | Filtering, normal estimation, Poisson reconstruction, segmentation and export |
| Model editing | Blender in background mode | Cleanup, material application, lighting, rendering and rotation video |
| Generative video | Local ComfyUI and Seedance custom nodes | Multiview rendering and model-to-video workflow execution |
| Persistence | JSON metadata plus local filesystem | Workflow library, model history, Assets and temporary sessions |

## 1.5 System Requirements and Limitations

The basic interface requires Node.js and pnpm. Frame extraction requires FFmpeg. Video-based reconstruction requires COLMAP and the Python packages listed in `scripts/requirements-python.txt`. True training additionally requires a compatible Nerfstudio installation and, in the current configuration, the CUDA-backed gsplat rasteriser. Blender-dependent nodes require a discoverable Blender executable. ComfyUI Video Gen requires a running local ComfyUI server with the required custom nodes and models.

Hardware directly affects behaviour. CUDA can support True training and GPU COLMAP operations. Apple MPS and CPU systems can run the initializer route, but the current Nerfstudio Splatfacto setup does not treat MPS as a substitute for the CUDA rasteriser. Dense COLMAP processing and Poisson reconstruction can consume substantial memory and time on large inputs.

Output quality is bounded by source capture quality. Motion blur, low texture, reflections, repeated patterns, changing lighting, insufficient view overlap and a moving background can all damage camera recovery or geometry. Foreground masks reduce environmental contamination but do not repair incorrect camera poses. Mesh post-processing can remove small unsupported sheets and fill small holes, but it cannot reconstruct detail that is absent from the point cloud.

# 2. System Architecture

## 2.1 Architecture Overview

[[FIGURE:architecture]]

The browser is the orchestration surface. React Flow stores the current graph and node data, while `WorkflowContext` owns the workflow-running flag, session identifier and API wrapper. Next.js API routes validate requests, resolve local files and start either synchronous utilities or asynchronous tasks. Python and desktop applications perform the heavy work. Results are returned as session-scoped URLs or published asset URLs.

The design deliberately separates orchestration from processing. The frontend does not execute COLMAP or Blender commands. API routes do not implement Poisson reconstruction themselves. Instead, each boundary passes a narrow set of typed fields or command-line arguments. This makes it possible to update a Python algorithm without changing the canvas, provided the result contract remains stable.

## 2.2 Frontend Modules

| Module | Responsibility | Key files |
|---|---|---|
| Flow editor | Owns React Flow nodes and edges, drag/drop, data propagation and completion detection | `src/components/flow/FlowEditor.tsx` |
| Node components | Render controls, previews, progress and node-specific API effects | `src/components/flow/custom-nodes.tsx` |
| Sidebar | Provides Node Library, Assets, saved workflows and model history | `src/components/flow/Sidebar.tsx` |
| Top bar | Provides Save, Clear, Run, Stop and workflow progress | `src/components/flow/TopBar.tsx` |
| Workflow context | Maintains run state, the ephemeral session ID and the session-aware fetch wrapper | `src/lib/workflow-context.ts` |
| Workflow engine | Defines port mapping, trigger readiness, completion and downstream pushes | `src/lib/workflow-engine.ts` |
| 3D viewers | Preview interactive models, point clouds and splat-oriented PLY data | `InteractiveModelViewer.tsx`, `ModelViewer.tsx`, `PLYViewer.tsx`, `SplatViewer.tsx` |
| Asset helpers | Map Assets to compatible nodes and resolve thumbnails and downloads | `src/lib/asset-drop-mapping.ts`, `asset-preview.ts`, `asset-download.ts` |

Most Three.js viewers are loaded dynamically with server-side rendering disabled. This prevents hydration mismatches and avoids initialising WebGL on the server. Viewer components are also disposed or reset when Clear removes their media URLs, which prevents stale content and reduces unnecessary rendering work.

## 2.3 Backend Modules

The backend is implemented through Next.js route handlers and a custom server entry point. `src/server.ts` starts Next.js on port 5001 by default, performs startup cleanup and registers graceful exit cleanup. API routes under `src/app/api/` form the local service layer.

Long-running operations use small task-store modules. A generation route creates a task ID, records a `processing` state and starts the pipeline without waiting for completion. Status routes return the latest task object. Cancellation routes verify that the task belongs to the current workflow session before terminating its process tree. Point-cloud, Gaussian and mesh work use separate stores so that their progress and subprocess identifiers can be managed independently.

Filesystem helpers provide a single boundary for media URLs. `resolveClientMediaUrlToFilesystem` accepts a protected ephemeral URL or a recognised legacy public path and resolves it to a local file. `buildEphemeralFileUrl` returns a URL that can be consumed by the browser without exposing arbitrary filesystem access. Path normalisation rejects parent-directory traversal.

## 2.4 Request and Processing Flow

A typical asynchronous request follows this sequence:

1. The node calls the workflow-aware `apiFetch`, which attaches the current ephemeral session ID.
2. The API route validates required fields, the session identifier and external dependencies.
3. The route creates a task record and immediately returns a `taskId`.
4. The server starts a Python process or local command and records its PID where cancellation is required.
5. The node polls the relevant status endpoint and updates progress text.
6. The pipeline writes results inside `.data/ephemeral/{sessionId}`.
7. The task result exposes files through `/api/ephemeral-file` URLs.
8. The node marks itself complete and the workflow engine pushes the relevant output field to connected downstream handles.
9. Outputs selected for reuse are copied to `public/asset-published` and entered in `assets.json`.

Short operations such as asset-library reads and workflow-library updates return directly. ComfyUI video generation is handled in one HTTP request that internally waits for ComfyUI history, with a maximum wait of 45 minutes. The frontend still shows progress and prevents duplicate generation while the request is active.

## 2.5 Project Directory Structure

```text
src/
  app/                     Next.js page, layout and local API routes
  components/flow/         Canvas, nodes, controls, sidebar and viewers
  components/ui/           Shared shadcn/Radix components
  lib/                     Workflow rules, task stores, storage and integrations
  server.ts                Custom server and ephemeral lifecycle hooks
scripts/
  setup-macos.sh           macOS prerequisite check and guided dependency setup
  setup-windows.ps1        Windows prerequisite check and guided dependency setup
  *.py, *.sh               Python, Blender and runtime processing utilities
docs/releases/
  v1.0.0.md                Stable-release notes and installation summary
vendor/comfyui/seedance2/  Bundled optional Seedance deployment pack
public/asset-library/      Asset metadata JSON
public/asset-published/    Reusable runtime assets, ignored by Git
public/workflow-library/   Saved workflow metadata
public/model-history/      Lightweight model history metadata
.data/ephemeral/           Session-scoped intermediate and generated files
```

Generated media directories are ignored by Git. A fresh clone starts with source code, presets and lightweight metadata, not with the previous developer's videos, point clouds or models. The v1.0.0 cleanup also removed obsolete prototype scripts, default template graphics and old upload fixtures so that the source tree reflects the current workflow rather than historical experiments.

# 3. Workflow Engine and Data Contracts

## 3.1 Node Types

| Node | Required input | Main output | Completion condition |
|---|---|---|---|
| Video Upload | User-selected video | `videoServerPath` | `uploadStatus === 'done'` |
| Frame Extraction | `videoServerPath` | `frames` | `status === 'done'` |
| Gaussian Splat Gen | `framePaths` or `sourcePlyUrl` | `splatUrl` and retained source PLY | `status === 'done'` with a splat URL |
| Mesh Gen | `modelUrl`; texture only when connected | `outputUrl`, layer GLBs and metadata | `meshStatus === 'done'` |
| Model Cleanup | Connected `modelUrl` | `outputUrl` | `organizeStatus === 'done'` |
| Surface Processing | Connected `modelUrl` | `outputModelUrl`, material and light data | Output exists and Blender is idle |
| ComfyUI Video Gen | Connected `modelUrl` | `videoUrl` | `comfyStatus === 'done'` with video |
| Video Preview | Connected `videoUrl` or `modelUrl` | Displayed or generated video | Video exists and generation is idle |
| Material Gen | User text prompt | `textureUrl` | `status === 'done'`; API currently disabled |
| Sticky Note | None | None | Annotation-only; treated as complete |

The node library contains more node types than the Default Workflow. A saved custom workflow may therefore contain Material Gen, additional Mesh Gen nodes or different connections. Compatibility is preserved by keeping the node types and target mappings available even when they are absent from the current preset.

## 3.2 Edge and Port Mapping

Every edge identifies a source node, source handle, target node and target handle. `SOURCE_HANDLE_MAP` maps a source handle to one node-data field. For example, `gaussianSplat.splat-output` reads `splatUrl`, while `modelSurface.obj-output` reads `outputModelUrl`. `TARGET_HANDLE_MAP` converts that value into the target node's expected data shape.

Target conversion is also responsible for metadata forwarding. A Mesh Gen input receives an inferred input type, Gaussian count and compute backend where relevant. Model Cleanup and Surface Processing receive layer names and layer GLB URLs. ComfyUI receives the model URL and lighting metadata. Video Preview accepts either a model for rotation rendering or an already generated video for immediate playback.

Gaussian output routing is mode-aware. True training uses the `splat-output` handle. Fast Initializer and direct PLY use the `mesh-output` handle so that Mesh Gen receives the appropriate source geometry. The visual connection is updated to match this route; the downstream node contract remains `model-input`.

## 3.3 Trigger Conditions

Trigger readiness is calculated from node data and incoming edges. Frame Extraction waits for a video path. Gaussian Splat Gen accepts either frames or PLY. Mesh Gen always requires a model; its texture input becomes required only when a texture edge is connected. Processing nodes such as Model Cleanup, Surface Processing and ComfyUI Video Gen require an incoming connection during automatic workflow execution, although their UI may support manual asset input.

This distinction prevents isolated nodes from starting merely because stale data remains in their state. It also allows optional inputs without forcing placeholder data. A downstream push occurs only after the source node satisfies its completion condition and the mapped source field is neither `null` nor `undefined`.

## 3.4 Data Propagation

| Field | Meaning | Typical producer and consumer |
|---|---|---|
| `videoServerPath` | Browser-accessible uploaded video | Video Upload -> Frame Extraction |
| `frames` / `framePaths` | Ordered frame URLs | Frame Extraction -> Gaussian Splat Gen |
| `sourcePlyUrl` | Source point cloud reconstructed or uploaded | Gaussian Splat Gen -> Mesh Gen initializer route |
| `splatUrl` | 3DGS-compatible PLY output | Gaussian Splat Gen -> Mesh Gen trained route |
| `modelUrl` | Current model input for a processing node | Mesh Gen, Cleanup, Surface, ComfyUI or Assets |
| `outputUrl` | Processed primary model | Mesh Gen or Model Cleanup -> downstream |
| `layerGlbUrls` | Per-region GLB files for editing | Mesh Gen -> Cleanup -> Surface Processing |
| `layerNames` | Stable region labels matching layer files | Mesh and Blender processing chain |
| `lightParams` | Ambient, key, fill and exposure settings | Surface Processing -> ComfyUI or Video Preview |
| `videoUrl` | Existing or generated video | ComfyUI -> Video Preview or Assets drop |
| `promptId` | ComfyUI execution identifier | ComfyUI Video Gen status and diagnostics |

Layer GLBs are internal editing artefacts. When they are published, they are first combined into one `merged.glb` whose internal object names preserve the layer identity. This gives Assets one reusable model rather than up to eight unrelated files.

## 3.5 Run, Stop and Clear

Run sets the workflow context to active and allows ready nodes to begin. Completion is assessed over the connected processing graph. When all reachable terminal nodes are complete, the workflow automatically stops. Sticky notes do not block completion.

Stop calls `/api/cancel-workflow-tasks` for the active session. Gaussian cancellation can also cancel an associated point-cloud task and terminate recorded process trees. Cancellation changes task state before killing the process, which prevents a late subprocess callback from incorrectly marking the task complete.

Clear is a UI and session reset, not a deletion of published Assets. It clears uploaded and generated media fields, errors, progress and preview state while preserving the node layout and edge topology. Runtime node and edge IDs are regenerated so that React effects and viewer instances do not reuse stale lifecycle state. The previous ephemeral session is cleaned, and subsequent work receives a fresh session ID.

## 3.6 Saved Workflows and Compatibility

The workflow library stores a name, node array, edge array and timestamps in lightweight JSON. The built-in Default Workflow is inserted at read time, marked as `readonly` and `preset`, and cannot be renamed or deleted. User workflows can be created, renamed and removed independently.

Loading an older workflow does not automatically rewrite its topology. Legacy workflows with a second Mesh Gen or Material Gen therefore remain loadable. New default instances use the current Surface Processing to ComfyUI Video Gen connection. When extending node data, new fields should be optional or initialised by the node component so that older saved JSON remains usable.

# 4. Reconstruction Pipeline

## 4.1 Video Upload and Frame Extraction

**Purpose.** The first two nodes convert an arbitrary local video into a bounded, ordered set of high-quality still images suitable for feature matching. The default target is 120 frames. The API accepts values from 1 to 300 so that the user can trade coverage against reconstruction cost.

**Input.** Video Upload accepts a browser `File`. The file is first written to the current ephemeral session. The frontend then records it through the Asset Library. When publishing succeeds, the node replaces the temporary URL with the published URL; if publishing fails, it retains the temporary path so that the workflow can still continue.

**Processing.** Frame Extraction resolves the video URL to a local file, uses FFprobe to obtain duration and calculates `fps = requestedFrameCount / duration`. FFmpeg then applies that sampling rate and writes JPEG images using quality setting 2. This produces approximately uniform temporal coverage instead of taking the first 120 frames or relying on video metadata for camera parameters.

FFmpeg extracts pixels only. It does not recover the camera trajectory, focal length or per-frame extrinsic transforms required for multi-view optimisation. These are estimated later by COLMAP. Changing frame extraction therefore affects the evidence available to SfM, but it does not preserve or create camera poses by itself.

**Output.** Frames are stored under the session's frame directory and returned as ordered ephemeral URLs with an output-folder identifier and actual frame count. Frames are not added to Assets because they are intermediate data and can be regenerated from the published video.

**Failure handling.** The route rejects missing session headers, absent video paths and an unavailable FFmpeg executable. Invalid paths are not passed to the shell. A zero-frame result is treated as an error. Very short videos may yield fewer distinct frames than requested, while variable-frame-rate or corrupt videos may require preprocessing outside the application.

**Key files.** `src/app/api/upload-video/route.ts`, `src/app/api/extract-frames/route.ts`, `src/lib/uploaded-video-asset.ts`.

## 4.2 COLMAP Reconstruction

**Purpose.** COLMAP recovers camera calibration, camera motion and source geometry from the extracted frames. Its sparse model is the camera-pose foundation for True training; its dense output is the preferred geometric initializer for Fast Initializer.

**Input.** `/api/generate-pointcloud` receives frame URLs and flags controlling dense fusion, legacy segmentation, foreground masks and workspace preservation. It requires a valid ephemeral session and a discoverable `colmap` command.

**Processing.** The route copies the selected images into an isolated COLMAP workspace and performs the following stages:

1. Foreground masks are generated when enabled and accepted only if basic quality checks pass.
2. `feature_extractor` detects local image features and writes the COLMAP database.
3. `sequential_matcher` is used for the camera-oriented COLMAP-only path, while the full reconstruction path can use exhaustive matching.
4. `mapper` performs incremental Structure from Motion and writes the sparse model.
5. `image_undistorter` prepares a dense workspace using the solved camera model.
6. `patch_match_stereo` estimates depth and normal information across registered views, with geometric consistency enabled.
7. `stereo_fusion` combines consistent depth samples into a dense PLY point cloud.

If dense stereo or fusion fails, the route converts the sparse `points3D` model to PLY and continues with a lower-density fallback. The task result identifies the selected source and may expose the preserved COLMAP workspace to the Gaussian training stage.

**Output.** The stage returns a point-cloud URL, point count, sparse-model paths, registered image information and, when preserved, the COLMAP workspace required by Nerfstudio. These fields remain within the workflow session unless a user-visible splat or model output is explicitly published.

**Failure handling.** Common failures include too few registered images, missing overlap, motion blur, textureless surfaces and strong reflections. Dense failure is recoverable through sparse fallback; mapper failure is not. GPU use is enabled when an NVIDIA device is found, otherwise COLMAP is configured for CPU operation where supported. Each external command has a timeout and tracked PID.

**Key files.** `src/app/api/generate-pointcloud/route.ts`, `src/lib/pointcloud-task-store.ts`, `scripts/depth_estimate.py`, `scripts/depth_fusion.py`.

## 4.3 Foreground Masks

**Purpose.** Foreground masks reduce features and depth samples belonging to the room, turntable or operator. This is especially useful when the intended object occupies a small part of the image.

**Processing.** `generate_foreground_masks.py` uses the configured local background-removal runtime to produce a mask for each frame. A generated set is checked before it is passed to COLMAP. Accepted masks are supplied through the COLMAP image-reader mask path. Additional point-cloud filtering utilities can use the same image-space masks together with camera projections.

**Limitations.** A mask changes which pixels contribute to matching and fusion; it does not contain camera information and cannot correct a wrong pose. Transparent, reflective, thin or dark objects are difficult for general foreground segmentation. An incomplete mask may remove useful features, while a loose mask leaves environmental geometry. For these reasons, the pipeline falls back to unmasked reconstruction when mask quality checks fail rather than forcing a visibly defective mask set.

**Failure handling.** Missing Python packages or model weights should produce a readable warning and allow COLMAP to continue without masks. Mask generation must never delete the source frames. Masks are intermediate files under the session and are not published to Assets.

**Key files.** `scripts/generate_foreground_masks.py`, `scripts/filter_pointcloud_by_masks.py`, `src/app/api/generate-pointcloud/route.ts`.

## 4.4 Gaussian Splat Generation

Gaussian Splat Gen has two execution routes. The selected route is stored in `trainingMode`, displayed in the node and reflected by its active output handle.

### True training

True training requires extracted frames, valid COLMAP camera poses, Nerfstudio commands and a compatible CUDA/gsplat environment. The pipeline preserves the COLMAP workspace, prepares the dataset and invokes `train_gaussian_splat.py`, which coordinates `ns-train` and `ns-export`. Nerfstudio optimises Gaussian position, scale, rotation, opacity and colour against the input views through differentiable rendering. The output is a trained Gaussian representation rather than a point cloud converted by a single initialisation pass.

Training iterations are normalised by the API, and progress parsing reports the current iteration when available. The backend allows a long training-process timeout because the workload may extend well beyond the frontend polling window on large datasets. True training is selected only when the request asks for it and the capability probe confirms support.

### Fast Initializer

Fast Initializer obtains source geometry from COLMAP dense fusion or a direct PLY upload. `generate_gaussian_splat.py` converts each point into fields expected by a 3DGS-style PLY, including opacity, scale and orientation defaults. This route is substantially faster and works on CPU or Apple systems, but it does not optimise the representation by re-rendering the source photographs.

The initializer's geometric quality can never exceed the source point cloud. Dense matching and fusion improve that source, while foreground masks reduce contamination. Sparse or ring-like sampling, inconsistent depth and missing object surfaces remain visible downstream and may become holes or sheets during Poisson reconstruction.

### Device selection

The backend checks NVIDIA capability first, then Apple MPS, then falls back to CPU. In the current setup, CUDA is the supported True training path. MPS is useful for local Python operations but is reported as initializer-only when the gsplat CUDA extension is unavailable. The `/api/gaussian-device` endpoint exposes this capability before a run begins.

**Output.** Both routes return `splatUrl`, `sourcePlyUrl`, Gaussian count, target PLY description, device type, compute-backend label and selected mode. The old Gaussian Auto Layers behaviour has been removed: legacy `enableSegmentation` requests are ignored, and layer generation belongs to Mesh Gen after a triangle mesh exists.

**Key files.** `src/app/api/generate-gaussian-splat/route.ts`, `scripts/generate_gaussian_splat.py`, `scripts/train_gaussian_splat.py`, `src/lib/gaussian-output-routing.ts`, `src/lib/gaussian-segmentation-policy.ts`.

## 4.5 Direct PLY Input

A PLY file contains geometry and possibly colour or Gaussian attributes, but it normally does not contain the image set and calibrated camera poses needed to compare rendered views with source photographs. For that reason, PLY-only input always uses the initializer path even if the UI previously requested True training.

The upload is stored in the current session, previewed by a PLY or splat viewer and forwarded through the Gaussian node's mesh-oriented output. The generated 3DGS-field PLY and the original source PLY remain distinct. Mesh Gen should reconstruct from the geometry route selected by the workflow engine rather than assuming every `.ply` represents a trained radiance field.

Direct upload is useful for testing mesh reconstruction independently of camera recovery. It is also the recommended diagnostic route when determining whether a defect originates in COLMAP/Gaussian generation or in Mesh Gen: if the same source PLY produces the defect repeatedly, the investigation can focus on normals, density trimming and reconstruction profiles.

## 4.6 Progress, Timeout and Cancellation

Point-cloud and Gaussian generation are asynchronous. Start endpoints return task IDs, and the frontend polls `/api/pointcloud-status` or `/api/gaussian-status`. The Gaussian frontend polling policy waits up to 16 minutes at the current cadence before reporting a client-side timeout. The server-side Nerfstudio process may have a longer ceiling, so a frontend timeout does not by itself prove that the subprocess crashed.

Each task records status, progress text, optional progress step, session ID and active process identifiers. Cancel routes require a matching session to prevent one browser session from cancelling another task. Process-tree termination is used because COLMAP, Python and training launchers may create child processes. Stop should be preferred to closing the browser while a heavy task is running.

When diagnosing a timeout, check the task status endpoint and server log before restarting. Distinguish dependency errors returned before task creation, processing errors stored on the task and client polling expiry. This distinction determines whether the remedy is installation, input improvement, algorithm tuning or simply a longer wait.

# 5. Mesh and Model Processing

## 5.1 Mesh Gen Input Rules

**Purpose.** Mesh Gen converts a PLY or splat-oriented input into a conventional triangle mesh and prepares model outputs for Blender and ComfyUI. It can also process existing OBJ or GLB inputs through compatibility routes.

The `model-input` handle is required. The workflow engine infers `ply`, `splat`, `obj` or `glb` from the source node and URL. A PNG texture handle is optional unless an edge is attached to it; once connected, Mesh Gen waits for both model and texture data. This rule allows a simple model-only workflow without weakening the contract of a deliberately connected Material Gen branch.

The primary reconstruction endpoint accepts `glb`, `obj` or `ply` as output formats. Reusable model publication is intentionally limited to GLB, OBJ and FBX policies; a raw PLY remains categorised as point-cloud or splat data rather than a finished 3D model asset.

## 5.2 Reconstruction Profiles

Mesh reconstruction uses a profile to avoid applying one Poisson configuration to every object. The public choices are `auto`, `default`, `default_general`, `closed_solid`, `thin_structure`, `flat_panel`, `high_detail_ornamental` and `noisy_scan`.

In auto mode, `gs_to_mesh.py` measures properties such as bounding-box ratios, neighbour spacing, density variation, point count and geometric occupancy. It scores the profiles and avoids choosing a specialised profile when evidence is weak. A manually selected profile bypasses this choice and is recorded as forced in the result metadata.

Profiles control voxel size, statistical and radius filtering, normal neighbourhoods, normal orientation, Poisson depth and scale, density trimming, connected-island thresholds, smoothing and defect post-processing. `thin_structure` and `flat_panel` retain more disconnected or slender geometry; `closed_solid` favours consistent normals and a coherent volume; `noisy_scan` applies stronger filtering and smoothing; `high_detail_ornamental` reduces smoothing to protect fine detail.

## 5.3 Surface Reconstruction

The PLY pipeline follows these stages:

1. Load positions and available colours, remove invalid or duplicated points and estimate object scale.
2. Downsample and apply profile-specific statistical or radius outlier filtering.
3. Estimate normals using a radius derived from voxel size, median neighbour distance and object scale.
4. Orient normals consistently across local tangent relationships; use a camera-facing mode only where the profile requests it.
5. Run Open3D Poisson surface reconstruction with profile-specific depth, scale and linear-fit settings.
6. Trim low-density vertices when the profile defines a percentile threshold.
7. Remove only very small connected triangle islands.
8. Remove unsupported, boundary-heavy flying sheets under conservative area-loss limits.
9. Fill small boundary loops whose size and estimated area fall below profile thresholds.
10. Apply mild Laplacian smoothing where configured and transfer source colours to the mesh.

The flying-sheet filter does not classify geometry by thickness alone. A chair seat may also be thin, so deletion requires a combination of poor point support, small component area or face ratio and a high boundary ratio. A maximum permitted area loss causes the operation to roll back when removal would be too destructive. Hole filling is similarly limited to small loops; large openings are preserved rather than guessed.

**Output.** The script reports vertex and face counts, selected profile, profile-selection evidence, density threshold, removed-point statistics, filled-hole statistics and all segmentation outputs as one JSON result. The API converts paths inside the mesh job directory into ephemeral URLs.

**Failure handling.** An empty mesh after trimming produces a direct error with advice to use a denser point cloud. JSON parsing is tolerant of log prefixes but requires a final result object. The API rejects unsupported formats, unknown profiles and missing Open3D, NumPy or Trimesh dependencies before starting.

**Key files.** `src/app/api/generate-mesh/route.ts`, `scripts/gs_to_mesh.py`, `src/lib/mesh-task-store.ts`.

## 5.4 Geometry Layer Segmentation

`geometry_graph_surface` runs after the main reconstructed mesh has been cleaned, smoothed and colourised. It works on triangle faces rather than raw Gaussian points. Face adjacency provides the graph; the angle between denoised adjacent-face normals provides the principal boundary signal.

The algorithm smooths face normals without averaging across likely creases, builds weighted adjacency, forms connected regions and merges regions that are too small. Each region is classified using plane-fit residual and internal normal spread. Current labels include planar and smooth-curved descriptions. A final region-reduction pass merges compatible neighbours until no more than eight surface layers remain.

Each region is exported as `layer_NNN_<surface_type>.glb`. `layers_meta.json` records the segmentation profile, configuration, region area, face count, colour and descriptors. The main mesh remains the authoritative complete object. Layer files are editing views used by Surface Processing; they are not independently published to Assets.

This is geometric, not semantic, segmentation. It can distinguish changes in surface orientation or curvature but cannot reliably name a chair seat, chair leg, screw head or bottle cap. Semantic layering would require category recognition, 2D or 3D semantic models, projection or feature association and multi-view label reconciliation.

## 5.5 Model Cleanup

Model Cleanup invokes Blender in background mode to standardise the reconstructed model for later editing. The route validates the session and model path, resolves the Blender executable and runs `blender_organize.py`. The script can import supported model formats, organise geometry, apply compatibility fixes and export GLB and OBJ representations.

The main model is cleaned even when layer files are available. Layer metadata is forwarded rather than replacing the main-model operation. If the model is still a browser `blob:` URL, the node waits until a server-visible path exists.

Blender absence is reported as HTTP 503. A narrowly defined fallback can pass through the original model when Blender crashes before producing script JSON, preserving preview and downstream work. The fallback is not used when the Blender script itself reports a model-processing error, because that error indicates that a silent pass-through could hide invalid output.

**Key files.** `src/app/api/blender-organize/route.ts`, `scripts/blender_organize.py`, `src/lib/blender-cleanup-fallback.ts`, `src/lib/model-cleanup-mode.ts`.

## 5.6 Surface Processing

Surface Processing combines interactive Three.js preview with Blender-backed output. Users can select a layer, change Principled BSDF parameters and adjust scene lighting. Material fields include base colour, metallic, roughness, emission, alpha and normal scale. Lighting covers ambient intensity, key and fill intensity, colour, azimuth, elevation and exposure.

The backend supports `list-groups` and `apply` actions. `list-groups` inspects the model using a short-lived operating-system temporary directory and returns available object or material groups. `apply` writes optional layer-parameter JSON, passes material, texture and light data to Blender and exports a processed model. Rendering is optional and produces a preview image when requested.

Per-layer parameters are applied in one Blender run where possible. The resulting model URL and lighting data are forwarded directly to ComfyUI Video Gen. The `Apply Blender Render` button performs an explicit output update; changing the WebGL preview alone does not modify the file on disk.

**Failure handling.** The route rejects invalid model or texture paths, unsupported extensions, unknown actions and missing Blender. It returns Blender's explicit error when available and includes only bounded diagnostic output. A failure leaves the previous valid model visible so that the user can adjust parameters or retry.

**Key files.** `src/components/flow/custom-nodes.tsx`, `src/components/flow/LightControls.tsx`, `src/app/api/blender-material/route.ts`, `scripts/blender_material.py`.

# 6. Local Tool Integration

## 6.1 FFmpeg and COLMAP

FFmpeg and COLMAP are invoked as argument arrays, not concatenated shell commands. This avoids shell quoting errors and reduces injection risk. Dependency checks run before task creation so that missing executables return a direct 503 response instead of a task that later fails without progress.

FFprobe reads duration. FFmpeg writes extracted frames and may be used by rendering scripts to encode output. COLMAP commands run in a job-specific workspace and have stage-appropriate timeouts. Dense stereo output is parsed for per-image progress. Subprocess output is bounded in memory where commands may produce large logs.

Developers should test command availability from the same environment that starts Next.js. A command available in an interactive terminal may still be missing from a GUI-launched process if PATH differs. The development scripts and explicit environment variables are the preferred place to correct this.

## 6.2 Blender Integration

Blender runs with `--background --python <script> -- <arguments>`. This avoids dependence on an open Blender window and makes the operation repeatable. The application resolves a known Blender executable and passes absolute local paths for inputs and output directories. Blender scripts print a final JSON object that the API converts into client URLs.

Separate scripts own cleanup, material processing and rotation rendering. Keeping them separate reduces command complexity and allows each API to validate a narrower contract. The server never automates Blender through mouse or keyboard events.

Model Cleanup and Surface Processing write into the current ephemeral session. Rotation video also writes to the session before its result is published to Assets. Blender files and generated media should not be written into source-controlled directories.

## 6.3 ComfyUI Integration

ComfyUI Video Gen communicates through the local HTTP API. The default base URL is `http://127.0.0.1:8000`. `normalizeComfyUrl` accepts only `localhost`, `127.0.0.1` or `::1`, preventing the folder-detection and local-copy behaviour from being exposed to an arbitrary remote host.

The integration sequence is:

1. Request `/system_stats` and inspect ComfyUI's startup arguments.
2. Detect explicit `--input-directory` and `--output-directory`, or derive them from `--base-directory`; otherwise derive the data root from the `main.py` path.
3. Resolve `input/3d` using node override, then `COMFYUI_3D_INPUT_DIR`, then automatic detection.
4. Copy the final GLB, GLTF, OBJ, FBX or Blend model into the detected folder with a job-specific name.
5. Merge node settings with the bundled API workflow preset.
6. Replace the model-loader and Seedance values while preserving workflow links.
7. POST the graph to `/prompt` with a generated client ID.
8. Poll `/history/{prompt_id}` until the SaveVideo output appears.
9. Download the result through `/view` rather than reading the output directory directly.
10. Save the video into the current ephemeral session, return its URL and publish it to Assets.

Using `/view` keeps output retrieval independent of the user's absolute ComfyUI output path. The detected output directory remains useful for diagnostics and status display.

## 6.4 Seedance Deployment Pack

The repository includes `vendor/comfyui/seedance2/`. It contains the `seedance_3d_multiview` and `seedance_ad_studio` custom-node folders plus the editable desktop workflow. The API-format JSON remains an internal application preset because it is submitted programmatically and is not useful as a normal editable ComfyUI workflow.

Status checking combines directory detection with ComfyUI object information. It reports whether required node types are available, which custom-node directories are present and whether a restart is likely to be required. Installation copies only the bundled, expected paths into the detected local ComfyUI data directory. It does not download model weights or third-party Python dependencies.

After installation, the user may need to restart ComfyUI before the node types are registered. A successful file copy therefore does not guarantee that generation can start immediately. The status panel distinguishes ready, missing, restart-needed and unchecked states.

## 6.5 Local Access Boundaries

The backend can read local files because local desktop integration is a core feature, but it limits browser-supplied paths. Ephemeral URLs are parsed into a validated UUID session and relative path. Relative paths containing `..` and paths escaping the session root are rejected. Legacy public URLs are accepted only under recognised media prefixes.

ComfyUI directory overrides follow this precedence: node setting, environment variable, automatic detection. Seedance custom-node and workflow directories may also be overridden through `COMFYUI_CUSTOM_NODES_DIR` and `COMFYUI_WORKFLOWS_DIR`. Overrides are intended for a trusted local developer, not untrusted browser users.

The local APIs do not implement authentication, rate limiting or multi-user isolation. They should bind to localhost for normal use. Deploying the current server to a shared network would require an additional security review covering authentication, file access, command execution, upload limits and task ownership.

# 7. Storage and Asset Lifecycle

## 7.1 Ephemeral Sessions

Every workflow run is associated with a UUID session. Intermediate and newly generated files are written below `.data/ephemeral/{sessionId}`. The directory is not served as a static public folder. Files are read through `/api/ephemeral-file`, which validates the UUID, relative path and final resolved location before returning content with a media-appropriate type.

Typical session subdirectories include uploads, frames, point-cloud workspaces, Gaussian exports, meshes, Blender outputs, ComfyUI videos, rotation videos and thumbnails. A job-specific UUID below each category prevents collisions when a node is run more than once in the same session.

Ephemeral URLs have the form:

```text
/api/ephemeral-file?sid=<session-uuid>&rel=<encoded-relative-path>
```

`parseEphemeralFileUrl` is the authoritative test for whether a URL represents a temporary file. Code should not rely on filename patterns or on the presence of `.data` in a client URL.

## 7.2 Published Assets

Reusable files are copied to `public/asset-published/{assetId}/`. Their metadata is stored in `public/asset-library/assets.json` as `AssetEntry` records containing ID, name, asset type, file URL, file type, optional thumbnail, source node and creation time.

The Asset Library supports five categories: `video`, `pointcloud`, `splat`, `model` and `render-video`. A POST operation publishes an ephemeral file before saving the entry. If the URL is already public, it is retained. Reusing a file URL updates the existing entry instead of creating a duplicate.

Deleting an Asset removes the metadata entry and attempts to remove its published file and thumbnail. Clear does not delete Assets. Startup and exit cleanup do not traverse `public/asset-published`, so reusable files remain available after temporary sessions are removed.

## 7.3 Publication Rules

| Output | Published to Assets | Reason |
|---|---|---|
| Uploaded source video | Yes | Reusable input and source of future frame extraction |
| Extracted frames | No | Regenerable intermediate set |
| Foreground masks | No | Reconstruction intermediate tied to frame set |
| COLMAP database/workspace | No | Large diagnostic and training intermediate |
| Gaussian output PLY | Yes | Reusable splat or point-cloud result |
| Mesh Gen GLB/OBJ/FBX | Yes | Reusable finished model output |
| Mesh Gen PLY | No as a model | Remains a point-cloud-style format |
| Individual layer GLBs | No | Internal editing parts, not standalone assets |
| Merged layered GLB | Yes | One reusable model retaining layer object names |
| Blender cleanup/surface intermediate | Normally no independent entry | Continues through the active workflow |
| ComfyUI generated video | Yes | Final reusable render video |
| Rotation preview video | Yes | Final reusable render video |
| Segmentation metadata JSON | No | Diagnostic metadata associated with the mesh job |

Mesh publication does not depend on a downstream edge. GLB, OBJ and FBX outputs are registered when Mesh Gen completes. When layer GLBs exist, the publication policy prefers merging them and publishing the single layered model. The primary complete mesh remains available to the active workflow.

## 7.4 Cleanup Policy

On server startup, session directories with modification times older than three days are removed. On normal `SIGINT` or `SIGTERM`, the server attempts to remove all ephemeral session directories and then exits. The root directory is recreated so the next start has a valid location.

This policy is best-effort. A forced process kill, operating-system crash or power loss cannot execute graceful cleanup. The three-day startup policy covers those cases. A running task must not be stored outside its session merely to avoid cleanup; instead, any output intended for long-term reuse should be published through the Asset Library.

Developers adding a new route should create outputs under the current session, return an ephemeral URL and explicitly decide whether the node publishes the result. Writing directly into an ad hoc `public/` directory creates files that are neither tracked by Assets nor removed by session cleanup.

[[FIGURE:lifecycle]]

# 8. API Reference

## 8.1 API Conventions

Most processing routes require an `X-Ephemeral-Session-Id` header or an `ephemeralSessionId` body field. The workflow-aware frontend fetch helper supplies the header. Start routes for point-cloud, Gaussian and mesh processing return task IDs; status routes are polled with `?taskId=`. Error responses use `{ "error": "message" }` with HTTP 400 for invalid input, 403 for session ownership failure, 404 for missing records, 503 for missing dependencies and 500 for processing failures.

The API is same-origin and local. There is no Swagger generator or authentication layer. The tables below are the maintained interface reference.

## 8.2 Session, Upload and Frames

| Method | Endpoint | Input | Output | Async | Common errors |
|---|---|---|---|---|---|
| POST | `/api/ephemeral-session` | `action: cleanup`, `sessionId` | Cleanup confirmation | No | Invalid action or UUID |
| GET | `/api/ephemeral-file` | `sid`, `rel` query | File body | No | Invalid path, not found |
| POST | `/api/upload-video` | Multipart video file | Temporary video URL and metadata | No | Missing file, write failure |
| POST | `/api/upload-model` | Multipart model file | Model URL, name and type | No | Missing session or file |
| POST | `/api/chunk-upload` | Initialise, upload chunk or complete | Upload session or final URL | No | Expired upload, bad chunk fields |
| POST | `/api/extract-frames` | `videoPath`, `frameCount` | Frame URLs, folder ID and count | No | FFmpeg missing, invalid video, zero frames |
| POST | `/api/open-ephemeral-folder` | Valid session folder request | Opens local frames folder | No | Unsupported platform/path or missing folder |

Example frame request:

```json
{
  "videoPath": "/asset-published/asset_example/source.mp4",
  "frameCount": 120
}
```

Example response:

```json
{
  "success": true,
  "frames": [
    "/api/ephemeral-file?sid=<session>&rel=frames%2F<job>%2Fframe_0001.jpg"
  ],
  "outputFolder": "<job>",
  "frameCount": 120
}
```

## 8.3 Point Cloud, Gaussian and Mesh Tasks

| Method | Endpoint | Input | Output | Async | Common errors |
|---|---|---|---|---|---|
| POST | `/api/generate-pointcloud` | Frames, mask/dense flags, session | `taskId` | Yes | COLMAP missing, no frames |
| GET | `/api/pointcloud-status` | `taskId` | Task status, progress and result | Poll | Task missing |
| POST | `/api/cancel-pointcloud` | `taskId`, session | Cancellation confirmation | No | Wrong session, task missing |
| GET | `/api/gaussian-device` | None | Device and True training capability | No | Probe failure falls back to CPU data |
| POST | `/api/generate-gaussian-splat` | Frames or PLY, mode, iterations, session | `taskId`, selected route and device | Yes | Trainer/Python missing, invalid session |
| GET | `/api/gaussian-status` | `taskId` | Task status, iterations and result | Poll | Task missing |
| POST | `/api/cancel-gaussian-splat` | `taskId`, session | Gaussian and child-stage cancellation | No | Wrong session, task missing |
| POST | `/api/generate-mesh` | `plyUrl`, format, profile, session | `taskId` | Yes | Missing Python packages, invalid profile |
| GET | `/api/mesh-status` | `taskId` | Mesh counts, URLs, profile and layers | Poll | Task missing |
| POST | `/api/merge-glb` | `glbPaths` | `mergedGlbUrl` | No | Invalid paths, missing Trimesh, merge failure |
| POST | `/api/cancel-workflow-tasks` | Session and known active task IDs | Cancellation summary | No | Invalid workflow session |

Example Gaussian start request:

```json
{
  "framePaths": ["/api/ephemeral-file?sid=<session>&rel=frames%2F..."],
  "trainingMode": "train",
  "trainingIterations": 1000,
  "ephemeralSessionId": "<session-uuid>"
}
```

The response reports the mode actually selected. A request for `train` may return `auto` with `trueTrainingUnavailableReason`. Clients must use the returned value rather than assuming the requested route was accepted.

Example mesh completion result:

```json
{
  "status": "done",
  "progress": "Done",
  "result": {
    "meshUrl": "/api/ephemeral-file?sid=<session>&rel=meshes%2F...%2Fmesh.glb",
    "meshFormat": "glb",
    "faceCount": 84210,
    "vertexCount": 42107,
    "reconstructionProfile": "thin_structure",
    "layerGlbUrls": ["/api/ephemeral-file?sid=<session>&rel=meshes%2F...%2Flayer_000_planar.glb"],
    "layerNames": ["Layer 1 - Planar"],
    "segmentationProfile": "geometry_graph_surface",
    "segmentationLabelCount": 6,
    "segmentationMetadataUrl": "/api/ephemeral-file?sid=<session>&rel=meshes%2F...%2Flayers_meta.json"
  }
}
```

## 8.4 Blender and Model Utilities

| Method | Endpoint | Input | Output | Async | Common errors |
|---|---|---|---|---|---|
| POST | `/api/blender-organize` | `modelUrl` | GLB/OBJ cleanup URLs and preview URL | Request waits | Blender missing, import or export failure |
| POST | `/api/blender-material` | Action, model, material/layer/light data | Groups or processed model/render URLs | Request waits | Bad action/path, Blender script error |
| POST | `/api/generate-rotation-video` | Model, FPS, duration, size, light data | MP4 URL and metadata | Request waits | Unsupported model, render/encode failure |
| POST | `/api/process-glb` | GLB URL and PNG texture | Processed GLB and preview | Request waits | Missing dependencies or invalid files |
| POST | `/api/process-obj` | OBJ URL and PNG texture | Processed OBJ/GLB and preview | Request waits | Incorrect route, invalid files |
| POST | `/api/generate-texture` | Reserved | HTTP 503 disabled response | No | Material API intentionally unavailable |

`/api/blender-material` supports two actions. `list-groups` returns inspectable group names without retaining output. `apply` accepts either one target group and material object or a `layerParams` map for multi-layer application. Optional `render: true` requests a still preview.

## 8.5 ComfyUI APIs

| Method | Endpoint | Input | Output | Async | Common errors |
|---|---|---|---|---|---|
| GET | `/api/comfy-video-status` | Optional local `comfyUrl` | Connection, version and detected paths | No | Disconnected or undetectable folders |
| GET | `/api/comfy-video-preset` | None | Bundled preset defaults | No | Internal preset load error |
| POST | `/api/generate-comfy-video` | `modelUrl`, settings, session header | Video URL, prompt ID and detected paths | Waits for history | Unsupported model, offline ComfyUI, timeout |
| GET | `/api/comfy-seedance-status` | Optional local `comfyUrl` | Required-node and folder status | No | Connection/object-info failure |
| POST | `/api/install-comfy-seedance-pack` | Optional local `comfyUrl` | Copied paths and restart status | No | Folder detection or copy failure |

Example generation request:

```json
{
  "modelUrl": "/api/ephemeral-file?sid=<session>&rel=blender-output%2F...%2Fmodel.glb",
  "settings": {
    "comfyUrl": "http://127.0.0.1:8000",
    "prompt": "A controlled product presentation with smooth camera motion.",
    "resolution": "720p",
    "ratio": "9:16",
    "duration": 10,
    "generateAudio": true,
    "seed": 20260724,
    "watermark": false
  }
}
```

## 8.6 Libraries, Assets and Thumbnails

| Method | Endpoint | Purpose |
|---|---|---|
| GET/POST/DELETE | `/api/asset-library` | List, publish/update and delete reusable Assets |
| POST | `/api/generate-asset-thumbnail` | Render a thumbnail for supported PLY/GLB/GLTF/OBJ sources |
| GET/POST/DELETE | `/api/model-history` | Maintain lightweight model history records |
| GET/POST/PUT/DELETE | `/api/workflow-library` | Read, save, rename and delete workflows |

The Asset Library's `assetType` must be one of `video`, `pointcloud`, `splat`, `model` or `render-video`. Required POST fields are `fileUrl`, `assetType` and `sourceNode`; name, file type and thumbnail can be derived or omitted. The Default Workflow returned by the workflow library is immutable even though user-created entries are editable.

# 9. Frontend Implementation

## 9.1 React Flow Canvas

`FlowEditor` runs inside `ReactFlowProvider` and the workflow context. It owns node and edge arrays, node-type registration, connection creation, deletion, asset drop handling and the effects that push completed outputs. The default graph is defined separately in `src/lib/default-workflow.ts`, which keeps preset content out of component rendering logic.

The custom workflow edge has an expanded interaction path. Clicking it sets a selected state, increases visual emphasis and displays a red delete icon near the midpoint. Delete and Backspace remove the selected edge unless focus is inside an input, textarea, select or editable element. Clicking the empty canvas clears selection.

Asset drop targeting uses measured node dimensions when available and conservative fallback dimensions for large preview nodes before React Flow has measured them. This is important because browser drag events provide canvas coordinates, while nodes can have dynamic heights.

## 9.2 Node State and Effects

Node components update their own `data` through React Flow's `setNodes`. Automatic processing effects depend on `workflowRunning`, required input fields and an idle status. A node sets a processing status before the request to prevent duplicate effects. On success it writes output fields and a done status; on failure it writes a user-visible error and returns to a retryable state.

The workflow engine provides a second, central propagation layer. This intentionally decouples data transfer from individual node layouts and gives tests a pure function for verifying connections. When adding a new node, developers must register its node type, source and target handles, trigger readiness, completion state, processing state and clear-data defaults.

## 9.3 Preview Components

GLB and GLTF models use Three.js loaders through React Three Fiber. OBJ compatibility paths are converted or processed before display where required. PLY input is inspected to select a point-cloud or Gaussian-oriented viewer. Video Preview uses a native video element when `videoUrl` is available and only invokes rotation generation when it receives a model instead.

Viewers preserve stable dimensions so model loading and status text do not resize nodes. Pointer controls allow orbit rotation in model previews. Continuous rendering is avoided where possible; invalidation or demand-based updates reduce CPU use when the scene is stationary. Clear removes URLs and remounts runtime IDs so old WebGL scenes and video frames do not remain visible.

## 9.4 Assets Drag and Drop

Asset compatibility is centralised in `asset-drop-mapping.ts`:

- A `render-video` dropped on Video Preview sets `videoUrl` and `videoName`, clears model generation state and plays the existing video directly.
- A supported model dropped on ComfyUI Video Gen sets `modelUrl` and clears prior video, prompt and error state.
- A model dropped on Video Preview sets `modelUrl` for rotation-video generation.
- A render video is not accepted by ComfyUI Video Gen, and unsupported node combinations return no update.

Sidebar previews use stored thumbnails when available. Render videos can fall back to the video file as their preview source. Model assets request generated thumbnails when missing. Thumbnail generation is a convenience and must not block the underlying asset from being listed or downloaded.

## 9.5 UI Status and Performance

Each processing node exposes an idle, processing, done or error presentation aligned with its internal fields. The Top Bar reports completed nodes against connected runnable nodes. Stop is available during active execution. Clear keeps the graph but removes runtime content.

ComfyUI connection and Seedance pack information are collapsed by default to reduce node height. Their summary lines retain native disclosure markers and Check/Install actions. Expanded rows show detected paths in muted text. Surface Processing places the explicit Blender render action immediately below the preview, before colour and material controls.

Performance-sensitive code should avoid changing node dimensions during hover or loading, avoid creating new Three.js scenes in ordinary React renders and avoid impure values such as `Date.now()` or `Math.random()` in JSX. Heavy viewers use dynamic imports with SSR disabled. Generated thumbnails make the Assets sidebar cheaper than embedding a live 3D canvas for every model.

# 10. Installation and Deployment

## 10.1 Prerequisites

The minimum UI installation requires Node.js 20 or later and pnpm 9 or later. The repository enforces pnpm and should not be installed with npm or yarn. Additional capabilities are enabled by local dependencies:

| Capability | Required software |
|---|---|
| Web interface and workflow editing | Node.js, pnpm |
| Video upload and extraction | FFmpeg and FFprobe |
| Video-based camera reconstruction | COLMAP |
| Point-cloud and mesh processing | Python plus `scripts/requirements-python.txt` |
| True training | Nerfstudio `ns-train`, `ns-export`, compatible CUDA and gsplat environment |
| Model cleanup and surface processing | Blender |
| Model-to-video generation | Local ComfyUI, Seedance custom nodes and required models |

The Python requirements include scientific, image and 3D packages used by scripts. Some packages, especially Open3D, Torch, Nerfstudio and rembg runtimes, have platform-specific wheels. A clean virtual or Conda environment is recommended for production demonstrations.

## 10.2 Install and Run

The stable source package is available from the GitHub Release `v1.0.0`. GitHub automatically provides ZIP and TAR source archives for the tag. After cloning the repository or extracting a release archive, run the platform setup checker from the repository root.

On macOS:

```bash
bash scripts/setup-macos.sh
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1
```

The scripts validate Node.js, pnpm and the shell required by the project, then report the availability of Python, FFmpeg, COLMAP, Blender, Nerfstudio and ComfyUI. They install locked JavaScript dependencies by default but do not silently install large external applications, AI models or provider credentials. Windows requires Git for Windows because the current `dev`, `build` and `start` commands invoke Bash scripts.

Use check-only mode when auditing an existing workstation:

```bash
bash scripts/setup-macos.sh --check-only
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1 -CheckOnly
```

Install the Python processing requirements through the selected interpreter when the reconstruction features are needed:

```bash
bash scripts/setup-macos.sh --install-python
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1 -InstallPython
```

Manual installation remains available:

```bash
pnpm install
pnpm python-deps
pnpm dev
```

Open `http://localhost:5001`. `pnpm dev` uses the project development script so that the custom server, expected port and local dependency discovery are applied consistently.

For a production build:

```bash
pnpm build
pnpm start
```

Run `pnpm ts-check` and `pnpm lint` before building. The production build explicitly selects the Next.js webpack path because the development inspector uses a custom Babel configuration; that inspector plugin is enabled only in development. The build script honours `PYTHON_BIN` when selecting the processing interpreter. The basic page can start without COLMAP, Blender or ComfyUI, but nodes that depend on missing tools will return 503 errors when used.

## 10.3 Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5001` | Next.js custom server port |
| `HOSTNAME` | `localhost` | Server bind host |
| `COZE_PROJECT_ENV` | Development unless `PROD` | Selects Next.js development/production behaviour |
| `PYTHON_ENV_NAME` | `studio3dgs` | Preferred Conda environment name used by development/start scripts |
| `PYTHON_BIN` | Conda environment interpreter or `python3` | Python executable for Gaussian, mesh and thumbnail tools |
| `NS_TRAIN_BIN` | `ns-train` | Nerfstudio training command override |
| `NS_EXPORT_BIN` | `ns-export` | Nerfstudio export command override |
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8000` | Local ComfyUI API base URL |
| `COMFYUI_3D_INPUT_DIR` | Auto-detected | ComfyUI `input/3d` override |
| `COMFYUI_CUSTOM_NODES_DIR` | Derived from data root | Seedance custom-node installation override |
| `COMFYUI_WORKFLOWS_DIR` | Derived from data root | Editable workflow installation override |
| `MPLCONFIGDIR` | Temporary local cache | Matplotlib cache location for helper scripts |
| `XDG_CACHE_HOME` | Temporary local cache | Python/model cache location |

For Python and Nerfstudio commands, the launch scripts use the priority `explicit environment override -> Conda environment named by PYTHON_ENV_NAME -> command available on PATH`. No developer-specific executable path is used as a default. Node-level ComfyUI `input/3d` override takes precedence over `COMFYUI_3D_INPUT_DIR`, which in turn takes precedence over runtime auto-detection. Environment variables should be set in the shell or launcher that actually starts the Next.js process.

## 10.4 Installation Levels

For frontend development, install only Node dependencies. For the reconstruction pipeline, add FFmpeg, COLMAP and Python packages. Add Blender when testing Model Cleanup, Surface Processing or rotation rendering. Add ComfyUI only when testing the final model-to-video branch.

This layered setup allows UI contributors to work without installing every 3D package. It also makes dependency failures explicit. Documentation and issue reports should state the installed level and operating system rather than saying only that "the workflow failed".

## 10.5 ComfyUI Setup

Start ComfyUI with its API reachable at the configured loopback URL. Use the node's Check action to confirm detected input, output and data directories. Check the Seedance pack separately. If missing, Install copies the bundled custom nodes and editable workflow. Restart ComfyUI, then check again so `/object_info` confirms the required node types.

The deployment pack does not guarantee model availability, API credentials or compatible versions of every third-party dependency. Maintain a separate list of required ComfyUI model files and account settings alongside release notes when distributing the project to a new machine.

## 10.6 Repository and Runtime Data

Runtime media is excluded from source control. A clone does not include the previous machine's Assets, model history or temporary sessions. The ignored `public/uploads/` directory is reserved for runtime upload data and should not be treated as distributable source. Large examples should be supplied separately and imported through the UI.

Do not commit `.data/`, `public/uploads/`, `public/asset-published/`, generated frames, COLMAP scenes, Blender output, textures or rotation videos. The bundled ComfyUI preset and intentionally distributed custom-node source under `vendor/` are part of the repository and should be versioned. Obsolete prototypes, default framework artwork and ad-hoc test fixtures should remain outside the release tree unless a maintained test or documented example references them.

Use the tagged `v1.0.0` GitHub Release when a reproducible source snapshot is required. Its release notes in `docs/releases/v1.0.0.md` record setup commands, optional dependencies, validation steps and known limitations. GitHub's generated source archives contain the tracked repository state; they do not contain ignored runtime Assets or temporary files.

# 11. Testing and Verification

## 11.1 Static Checks

Run the complete TypeScript and lint checks after any change to node data, API responses or UI components:

```bash
pnpm ts-check
pnpm lint
```

Type checking protects the cross-node field contracts. Linting detects unused imports, unsafe rendering patterns and React issues. Neither command validates external tools or reconstruction quality, so they are necessary but not sufficient.

## 11.2 TypeScript Unit Tests

Tests under `src/lib/*.test.ts` use Node's test runner through `tsx`. Important groups include:

- Default workflow topology and Surface Processing to ComfyUI propagation.
- ComfyUI preset extraction, prompt replacement, output-history parsing and directory detection.
- Seedance pack folder derivation, required node detection and workflow-copy policy.
- Gaussian output-handle routing, legacy Auto Layers suppression and 16-minute polling policy.
- Asset publication, sidebar visibility, download names, thumbnail fallback and node drop mapping.
- Mesh asset publication, including layered-GLB merge preference and format rules.
- Blender cleanup fallback and main-model cleanup selection.
- Workflow Clear graph regeneration and preservation of edge topology.
- Ephemeral startup TTL and exit cleanup behaviour.

Run an individual file with:

```bash
pnpm exec tsx --test src/lib/comfyui-workflow.test.ts
```

When modifying a shared contract such as workflow routing or Assets, run all directly related test files rather than only the new test.

## 11.3 Python Tests

Python tests cover foreground-mask output, mask-based point-cloud filtering, point-cloud segmentation utilities, reconstruction profile selection, geometry graph segmentation, mesh defect post-processing and thumbnail rendering. They should run with the same Python interpreter used by the application.

Representative commands are:

```bash
python3 scripts/test_foreground_masks.py
python3 scripts/test_geometry_graph_surface.py
python3 scripts/test_gs_to_mesh_profiles.py
python3 scripts/test_mesh_defect_postprocess.py
python3 scripts/test_render_model_thumbnail.py
```

Geometry tests should verify that every face receives one region ID, each region is connected, the layer cap is obeyed and exported files exist. Defect tests should cover both removal of unsupported sheets and preservation of valid thin surfaces.

## 11.4 Manual End-to-End Scenarios

Before release, verify these scenarios on the target workstation:

1. Upload a video, confirm it appears in Assets, extract the requested frame count and open the frame folder.
2. Run Fast Initializer from frames and confirm COLMAP progress, a splat/PLY preview and Mesh Gen input routing.
3. On a CUDA workstation, run True training and confirm the trained output uses the splat output handle.
4. Upload a PLY directly and confirm that the node reports initializer mode regardless of a previous True training selection.
5. Generate a mesh, inspect the selected profile, verify no more than eight layers and confirm the merged layered GLB appears in Assets.
6. Run Model Cleanup and Surface Processing, edit a layer, apply Blender output and confirm the processed file reaches ComfyUI Video Gen.
7. Check ComfyUI paths and Seedance status, generate a video and confirm Video Preview receives and plays it.
8. Drag an existing Render Video from Assets to Video Preview and verify immediate playback without regeneration.
9. Drag a model Asset to ComfyUI Video Gen and verify that old video state is cleared while the model becomes ready.
10. Start a long Gaussian task, press Stop and confirm the process and child point-cloud task stop.
11. Press Clear and confirm previews, errors and task IDs are cleared while nodes and edges remain.
12. Restart the backend and confirm published Assets remain while eligible old sessions are cleaned.

## 11.5 Release Acceptance

A release is acceptable when static checks pass, contract-focused unit tests pass, the relevant Python tests pass and at least one end-to-end route completes on the supported platform. Reconstruction quality should be assessed with known PLY/video fixtures rather than a new capture whose quality is unknown.

Record the operating system, GPU backend, Python environment, COLMAP version, Blender version and ComfyUI version for repeatable comparisons. A successful process exit is not sufficient if the resulting model is empty, severely fragmented or missing its layer metadata.

For release `v1.0.0`, `pnpm ts-check`, `pnpm lint`, the production build and macOS shell syntax checks passed. The macOS setup checker was exercised in normal and check-only modes: required web prerequisites passed, while unavailable optional tools were reported as warnings. The Windows PowerShell checker received static review but was not executed on a Windows host, so Windows runtime verification remains an explicit release acceptance item.

# 12. Troubleshooting and Maintenance

## 12.1 Troubleshooting Matrix

| Symptom | Likely cause | Checks | Resolution |
|---|---|---|---|
| Frame Extraction reports FFmpeg unavailable | Backend PATH does not contain FFmpeg | Run `ffmpeg -version` from the launch environment | Install FFmpeg or correct the launcher PATH |
| COLMAP registers few images | Poor overlap, blur, repeated/blank texture or aggressive masks | Inspect frames and sparse registration count | Improve capture, increase useful frames, relax/review masks |
| Dense matching fails but task completes | Patch Match resource or consistency failure | Check task progress and server log for sparse fallback | Reduce image size/count, verify GPU, accept sparse result only for diagnostics |
| Gaussian task times out in UI | Processing exceeds 16-minute polling window or process stalled | Query Gaussian status and inspect iteration/progress | Wait if active, Stop if stalled, reduce workload or use initializer |
| True training silently becomes initializer | CUDA/gsplat or Nerfstudio support probe failed | Read returned mode and unavailable reason | Install compatible environment or use Fast Initializer intentionally |
| PLY cannot use True training | No frames and COLMAP poses accompany the PLY | Confirm request contains only `plyUrl` | Supply original images/poses or use initializer |
| Mesh contains seat holes | Point cloud lacks consistent samples or density trimming is too strong | Inspect PLY density and selected profile | Improve source geometry; test thin/flat profile and conservative trimming |
| Mesh contains large thin flying faces | Inconsistent normals or Poisson bridges sparse support | Compare source PLY, normals and postprocess statistics | Use consistent-normal profile, improve sampling, tune conservative sheet filter |
| Too many surface layers | Noisy normals or fragmented adjacency before region cap | Inspect metadata and label count | Confirm current script, smoothing settings and eight-layer cap |
| Valid thin chair seat is removed | Flying-sheet thresholds are too aggressive | Compare area-loss rollback and source support | Reduce removal thresholds; keep combined support/boundary checks |
| Blender node returns 503 | Blender executable not found | Run Blender from the same environment | Install Blender or configure discoverable application path |
| Blender output parses incorrectly | Script crashed or printed no final JSON | Inspect bounded stderr and script output | Run the script directly with the same model and arguments |
| ComfyUI shows disconnected | Server is not running or URL/port differs | Open `/system_stats` on the loopback address | Start ComfyUI or update `COMFYUI_BASE_URL` |
| ComfyUI path is not detected | Startup arguments do not expose a usable data root | Expand status details and inspect `system.argv` | Set node `input/3d` override or environment variable |
| Seedance pack says restart needed | Files exist but node types are not registered | Check `/object_info` after install | Restart ComfyUI and check again |
| ComfyUI prompt rejects nodes/models | Missing custom dependencies or model configuration | Compare preset node types and ComfyUI errors | Install required nodes/models; do not edit workflow links blindly |
| Asset thumbnail is blank | Camera framing, unsupported material or stale thumbnail | Open model directly and regenerate thumbnail | Improve thumbnail renderer bounds and overwrite metadata thumbnail |
| Asset drag appears to do nothing | Drop target not compatible or node bounds not measured | Test mapping helper and drop inside node body | Use supported type-node pair; verify hit-test dimensions |
| Disk usage grows | Forced exits prevented cleanup or route wrote outside session | Inspect `.data/ephemeral` and untracked public media | Restart for TTL cleanup; move new routes to session storage/publication policy |

## 12.2 Diagnostic Order

Use a consistent diagnostic order. First verify input existence and format. Then query the node's API or task status. Next confirm the external executable and Python environment. After that, isolate the stage by using a known input: a known PLY for Mesh Gen, a known GLB for Blender or ComfyUI, and a short known video for extraction. Only tune algorithm parameters after the stage boundary is proven.

For geometry defects, preserve the source PLY, main mesh, selected profile, post-process statistics and segmentation metadata from one run. Comparing only the final GLB loses the evidence needed to decide whether the issue began in capture, COLMAP, Gaussian initialisation or Poisson reconstruction.

## 12.3 Maintenance Guidance

When adding an API route, validate the workflow session, resolve files through the shared helper, keep output under the session, use `execFile` or `spawn` with argument arrays and return bounded errors. Decide explicitly whether the output should be published. Add cancellation when a process can run long enough to outlive a normal UI interaction.

When adding a node or handle, update the node configuration, component registration, source/target maps, trigger logic, completion/processing checks, Clear defaults and tests. A node that renders correctly but lacks one of these registrations will not participate reliably in automatic workflows.

When modifying a Python result schema, update the API parser and frontend task type together. Preserve optional fields for saved-workflow compatibility. Log detailed diagnostics on the server but return concise errors to the node.

## 12.4 Future Extensions

Semantic layer generation is the most significant modelling extension. A practical route would render calibrated views, obtain object-part masks with a model such as SAM2 combined with category-aware labels, project labels back to mesh faces and reconcile them across views. Geometry regions would remain useful as a regularisation and connectivity stage.

Automated quality assessment could combine point support, normal consistency, hole statistics, self-intersection checks, connected-component measures and rendered-view comparison. The result should guide profile selection or warn the user rather than silently deleting geometry.

Foreground segmentation can be improved through object-aware prompts, temporal consistency and multi-view mask checking. Baseline macOS and Windows setup checkers now detect the main project prerequisites. Future distribution work should add automated Windows continuous integration, signed one-click installers, optional package-manager integration and explicit ComfyUI model inventory checks without silently downloading large dependencies. Remote or multi-user deployment would require a separate security architecture rather than exposing the current local command APIs directly.

# Appendices

## Appendix A. Complete API Summary

```text
SESSION AND FILES
  POST    /api/ephemeral-session
  GET     /api/ephemeral-file
  POST    /api/open-ephemeral-folder

UPLOAD AND INPUT
  POST    /api/upload-video
  POST    /api/upload-model
  POST    /api/chunk-upload
  POST    /api/extract-frames

RECONSTRUCTION
  POST    /api/generate-pointcloud
  GET     /api/pointcloud-status
  POST    /api/cancel-pointcloud
  GET     /api/gaussian-device
  POST    /api/generate-gaussian-splat
  GET     /api/gaussian-status
  POST    /api/cancel-gaussian-splat
  POST    /api/generate-mesh
  GET     /api/mesh-status
  POST    /api/merge-glb
  POST    /api/cancel-workflow-tasks

MODEL AND VIDEO PROCESSING
  POST    /api/blender-organize
  POST    /api/blender-material
  POST    /api/process-glb
  POST    /api/process-obj
  POST    /api/generate-rotation-video
  POST    /api/generate-texture               (disabled)

COMFYUI
  GET     /api/comfy-video-status
  GET     /api/comfy-video-preset
  POST    /api/generate-comfy-video
  GET     /api/comfy-seedance-status
  POST    /api/install-comfy-seedance-pack

LIBRARIES
  GET     /api/asset-library
  POST    /api/asset-library
  DELETE  /api/asset-library
  POST    /api/generate-asset-thumbnail
  GET     /api/model-history
  POST    /api/model-history
  DELETE  /api/model-history
  GET     /api/workflow-library
  POST    /api/workflow-library
  PUT     /api/workflow-library
  DELETE  /api/workflow-library
```

## Appendix B. Node Data Field Reference

| Node | Important mutable fields |
|---|---|
| Video Upload | `videoUrl`, `videoServerPath`, `videoName`, `coverUrl`, `targetFrameCount`, `uploadStatus`, `uploadError` |
| Frame Extraction | `videoServerPath`, `targetFrameCount`, `frames`, `outputFolder`, `frameCount`, `status`, `errorMessage` |
| Gaussian Splat Gen | `framePaths`, `sourcePlyUrl`, `splatUrl`, `trainingMode`, `trainingIterations`, `deviceType`, `computeBackend`, `targetPlyType`, `activeTaskId`, progress fields |
| Mesh Gen | `modelUrl`, `inputType`, `textureUrl`, `outputUrl`, `outputType`, `outputFormat`, `meshStatus`, `reconstructionProfile`, counts, layer fields |
| Model Cleanup | `modelUrl`, `outputUrl`, `outputType`, `organizeStatus`, `layerGlbUrls`, `layerNames`, `errorMessage` |
| Surface Processing | `modelUrl`, `outputModelUrl`, `materialParams`, `layerParams`, `lightParams`, `selectedLayer`, `renderUrl`, Blender status/error fields |
| ComfyUI Video Gen | `modelUrl`, preset settings, connection/pack status, path override, `comfyStatus`, `promptId`, `videoUrl`, `errorMessage` |
| Video Preview | `videoUrl`, `videoName`, `modelUrl`, `videoGenerating`, `lightParams`, `errorMessage` |

## Appendix C. Environment Variable Reference

Use the table in Section 10.3 as the authoritative list. For a portable setup, define only variables that differ from detected defaults. Avoid committing machine-specific absolute paths.

## Appendix D. Generated File Directory Map

```text
.data/ephemeral/<session>/
  uploads/                 temporary uploaded files
  frames/<job>/            extracted JPEG frames
  pointclouds/<job>/       COLMAP workspace, masks and point-cloud output
  gaussian-splats/<job>/   initializer or trained Gaussian export
  meshes/<job>/            main mesh, layer GLBs and layers_meta.json
  blender-organized/<job>/ cleanup output
  blender-output/<job>/    material, lighting and optional still render
  comfy-videos/<job>/      downloaded ComfyUI output
  rotation-videos/<job>/   locally rendered turntable video
  thumbnails/<job>/        temporary generated preview image

public/
  asset-library/assets.json
  asset-published/<assetId>/
  workflow-library/
  model-history/
```

## Appendix E. External Dependency Checklist

- Obtain a tagged source snapshot from GitHub Releases when reproducibility matters.
- Run `scripts/setup-macos.sh --check-only` or `scripts/setup-windows.ps1 -CheckOnly` before the first full workflow test.
- Node.js and pnpm meet the versions in `package.json`.
- Git for Windows and Git Bash are installed on Windows.
- Python 3.10-3.12 is preferred for current Open3D and rembg compatibility.
- FFmpeg and FFprobe are visible to the backend process.
- COLMAP is installed and can access the intended CPU/GPU backend.
- The selected Python interpreter imports Open3D, NumPy and Trimesh.
- Nerfstudio commands and CUDA/gsplat are available for True training.
- Blender is installed and callable in background mode.
- ComfyUI responds on a loopback URL.
- Seedance custom nodes are registered after restart.
- Required ComfyUI models and any provider credentials are configured locally.

## Appendix F. Example Workflow JSON

The complete Default Workflow is generated by `src/lib/default-workflow.ts`. A simplified saved representation is:

```json
{
  "name": "Default Workflow",
  "nodes": [
    { "id": "1", "type": "videoUpload", "data": { "targetFrameCount": 120 } },
    { "id": "2", "type": "frameExtraction", "data": { "frames": [] } },
    { "id": "gs1", "type": "gaussianSplat", "data": { "trainingMode": "auto" } },
    { "id": "4", "type": "modelGeneration", "data": { "outputFormat": "glb" } },
    { "id": "10", "type": "modelOrganize", "data": {} },
    { "id": "7", "type": "modelSurface", "data": {} },
    { "id": "11", "type": "comfyVideo", "data": {} },
    { "id": "9", "type": "videoPreview", "data": {} }
  ],
  "edges": [
    { "source": "1", "sourceHandle": "output", "target": "2", "targetHandle": "input" },
    { "source": "2", "sourceHandle": "output", "target": "gs1", "targetHandle": "input" },
    { "source": "gs1", "sourceHandle": "splat-output", "target": "4", "targetHandle": "model-input" },
    { "source": "4", "sourceHandle": "output", "target": "10", "targetHandle": "obj-input" },
    { "source": "10", "sourceHandle": "obj-output", "target": "7", "targetHandle": "obj-input" },
    { "source": "7", "sourceHandle": "obj-output", "target": "11", "targetHandle": "model-input" },
    { "source": "11", "sourceHandle": "video-output", "target": "9", "targetHandle": "video-input" }
  ]
}
```

The live Gaussian-to-Mesh source handle can change to `mesh-output` when the initializer or direct-PLY route is active. Code that loads a saved graph should preserve explicit handle IDs and allow the Gaussian node's route-selection logic to update the active connection when required.
