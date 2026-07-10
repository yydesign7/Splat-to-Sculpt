# Splat to Sculpt

[中文](README.zh-CN.md) | English

Splat to Sculpt is a visual workflow application for turning captured media into 3D assets. It uses a node-based canvas to connect video upload, frame extraction, Gaussian Splat generation, mesh conversion, model cleanup, surface processing, asset management, and video preview/export steps.

The project is built with Next.js 16, React, shadcn/ui, React Flow, and Three.js. Server-side scripts handle Gaussian Splat generation, PLY/GLB conversion, thumbnail rendering, model processing, and rotation video generation.

## Features

- Node-based workflow editor for 3D generation pipelines
- Video upload with configurable frame extraction
- Gaussian Splat generation with automatic device detection for CUDA, MPS, and CPU paths
- Optional true-training path for 3DGS-compatible splat PLY output
- Mesh generation from splat/PLY input for downstream GLB workflows
- Model cleanup, surface processing, asset library, and model history
- Preview support for video, PLY/splat, and GLB/model assets
- Asset thumbnails for easier file recognition in the sidebar
- Workflow library with protected preset workflows
- Run/stop controls with task cancellation for long-running backend processes

## Quick Start

Install dependencies:

```bash
pnpm install
```

Install Python processing dependencies when you need the 3D generation scripts:

```bash
pnpm python-deps
```

Start the development server:

```bash
pnpm dev
```

Open [http://localhost:5001](http://localhost:5001) in your browser.

Build the production version:

```bash
pnpm build
```

Start the production server:

```bash
pnpm start
```

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
├── lib/                 # Workflow logic, task stores, publishing helpers
└── hooks/               # Shared React hooks

scripts/
├── generate_gaussian_splat.py
├── train_gaussian_splat.py
├── gs_to_mesh.py
├── render_ply_thumbnail.py
└── other model/video processing scripts

public/
├── asset-library/       # Lightweight asset library metadata
└── model-history/       # Lightweight model history metadata
```

## Generated Files

Runtime assets are intentionally excluded from Git. Generated videos, frames, PLY files, GLB files, textures, COLMAP scenes, Blender outputs, local environments, and temporary `.data/` files should stay local.

Ignored runtime paths include:

```text
.data/
scripts/.mamba-root/
public/asset-published/
public/videos/
public/frames/
public/colmap-scenes/
public/blender-output/
public/obj-processed/
public/rotation-videos/
public/textures/
```

Large test assets should be distributed through GitHub Releases, cloud storage, or dataset hosting instead of the source repository.

## Technology Stack

- Next.js 16 and React 19
- TypeScript
- React Flow
- Three.js, React Three Fiber, and Drei
- shadcn/ui and Radix UI
- Tailwind CSS v4
- Python processing scripts for Gaussian Splat, mesh, thumbnail, and video tasks
- pnpm for package management

## Notes

This repository contains the application source code and processing scripts. Local generated assets and machine-specific environments are not committed, so a fresh clone starts with an empty asset library and model history.
