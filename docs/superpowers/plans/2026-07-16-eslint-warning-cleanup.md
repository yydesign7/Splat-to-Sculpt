# ESLint Warning Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all 19 current ESLint warnings while preserving runtime behavior and dynamic preview compatibility.

**Architecture:** Clean dead code directly, repair Hook data flow at its source, and isolate intentional native image rendering in one reusable component. ESLint with `--max-warnings 0` is the regression gate.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, ESLint 9, pnpm

## Global Constraints

- Use pnpm only.
- Do not use implicit `any` or `as any`.
- Preserve unrelated uncommitted changes.
- Dynamic preview images must continue supporting Blob and ephemeral URLs.

---

### Task 1: Establish The Zero-Warning Gate

**Files:**
- Test: existing ESLint configuration and source tree

**Interfaces:**
- Produces: a nonzero exit while any warning remains

- [ ] **Step 1:** Run `pnpm exec eslint . --max-warnings 0`.
- [ ] **Step 2:** Confirm it fails specifically because 19 warnings exceed the limit.

### Task 2: Remove Dead Code And Correct Hook Data Flow

**Files:**
- Modify: `src/app/api/chunk-upload/route.ts`
- Modify: `src/components/flow/FlowEditor.tsx`
- Modify: `src/components/flow/InteractiveModelViewer.tsx`
- Modify: `src/components/flow/Sidebar.tsx`
- Modify: `src/components/flow/custom-nodes.tsx`
- Modify: `src/lib/check-python-deps.ts`
- Modify: `src/lib/workflow-engine.ts`

**Interfaces:**
- Consumes: current callback props, metadata arrays, node data, and existing latest-value refs
- Produces: behavior-equivalent callbacks and effects with complete, stable dependency sets

- [ ] **Step 1:** Remove unused imports, state, geometry intermediates, map indices, and the unused trigger-info parameter.
- [ ] **Step 2:** Remove the unused `apiFetch` drop-handler dependency.
- [ ] **Step 3:** Read model metadata and layer callbacks through their latest-value refs during asynchronous loads.
- [ ] **Step 4:** Memoize Surface Processing's layer-name fallback and remove redundant nested callback dependencies.

### Task 3: Centralize Dynamic Preview Images

**Files:**
- Create: `src/components/flow/DynamicPreviewImage.tsx`
- Modify: `src/components/flow/Sidebar.tsx`
- Modify: `src/components/flow/custom-nodes.tsx`

**Interfaces:**
- Produces: `DynamicPreviewImage(props: ComponentPropsWithoutRef<'img'>): ReactElement`

- [ ] **Step 1:** Add the typed native-image wrapper with one documented `@next/next/no-img-element` exemption.
- [ ] **Step 2:** Replace the seven dynamic preview image elements with the wrapper.
- [ ] **Step 3:** Run `pnpm exec eslint . --max-warnings 0` and confirm zero warnings.

### Task 4: Verify Behavior And Types

**Files:**
- Verify: all modified files

**Interfaces:**
- Consumes: the running development application at `http://localhost:5001/`
- Produces: type-safe, lint-clean source with intact preview rendering

- [ ] **Step 1:** Run `pnpm ts-check`.
- [ ] **Step 2:** Run `git diff --check` and inspect the scoped diff.
- [ ] **Step 3:** Reload the app, inspect the canvas and available previews, and check browser console errors.
