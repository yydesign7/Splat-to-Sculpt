# Disable Material Gen Design

## Goal

Temporarily prevent Material Gen from calling any external image-generation API and remove it from the built-in Default Workflow, while preserving the node type and route path for a low-cost future restoration.

## Design

- Keep `POST /api/generate-texture`, but reduce it to a disabled endpoint with no Coze SDK, credential forwarding, image generation, download, or file-storage logic.
- Return HTTP `503` with error code `MATERIAL_GEN_DISABLED` so manually added or previously saved Material Gen nodes fail clearly instead of attempting an external request.
- Remove the `material` node from `initialNodes` in the built-in Default Workflow. No edge currently targets this node, so the preset edge list does not change.
- Keep Material Gen registered in the Node Library and workflow engine. Existing user-saved workflows remain unchanged and can be restored later by replacing the route implementation.
- Keep Surface Processing and its local material controls unchanged.

## Verification

- An integration check calls the disabled texture endpoint and inspects the Default Workflow returned by the workflow-library endpoint.
- Run TypeScript checking and ESLint after the behavior check passes.
