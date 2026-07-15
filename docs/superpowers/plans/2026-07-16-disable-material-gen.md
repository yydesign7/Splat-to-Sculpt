# Disable Material Gen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable Material Gen external API usage and remove the node from the built-in Default Workflow without deleting the reusable node feature.

**Architecture:** Preserve the existing route contract as an explicit disabled response and remove only the Material Gen entry from the preset node array. Verify both behaviors through the running Next.js application.

**Tech Stack:** Next.js 16, TypeScript 5, Node.js integration script, pnpm

## Global Constraints

- Use pnpm only.
- Do not remove Material Gen from the Node Library or existing saved workflows.
- Do not change Surface Processing material controls.
- Do not call an external image-generation API.

---

### Task 1: Add The Disabled-Behavior Integration Check

**Files:**
- Create: `scripts/test_material_gen_disabled.mjs`

**Interfaces:**
- Consumes: `POST /api/generate-texture` and `GET /api/workflow-library`
- Produces: A process exit code that proves both requested behaviors

- [ ] **Step 1: Write the failing integration check**
- [ ] **Step 2: Run it against the current app and confirm the expected failure**

### Task 2: Disable The External API Route

**Files:**
- Modify: `src/app/api/generate-texture/route.ts`

**Interfaces:**
- Produces: HTTP `503` JSON `{ error: string, code: "MATERIAL_GEN_DISABLED" }`

- [ ] **Step 1: Remove all external SDK, credential-forwarding, generation, download, and file-storage code**
- [ ] **Step 2: Return the stable disabled response from POST**

### Task 3: Remove Material Gen From The Default Workflow

**Files:**
- Modify: `src/lib/default-workflow.ts`

**Interfaces:**
- Produces: `initialNodes` without a node whose type is `material`

- [ ] **Step 1: Delete the Material Gen preset node and its obsolete layout comments**
- [ ] **Step 2: Run the integration check and confirm it passes**
- [ ] **Step 3: Run `pnpm ts-check`, `pnpm lint`, and diff validation**
