# ESLint Warning Cleanup Design

## Goal

Reduce the current ESLint result from 19 warnings to zero without changing workflow behavior or breaking Blob, ephemeral-session, and dynamically generated image previews.

## Warning Strategy

- Remove imports, state, local values, and callback parameters that have no reader.
- Correct Hook dependencies according to the data actually read by each callback or effect.
- In `InteractiveModelViewer`, use the existing latest-value refs inside asynchronous model loader callbacks so metadata and callbacks cannot become stale.
- Memoize the fallback layer-name array used by Surface Processing so its identity is stable across renders.
- Centralize raw dynamic image rendering in `DynamicPreviewImage`. These sources may be Blob URLs, session-protected URLs, or generated output URLs, so the component intentionally uses a native image element and contains one documented Next.js lint exemption.

## Scope

- No changes to node behavior, workflow topology, model processing, or API contracts.
- No conversion of dynamic preview sources to the Next.js image optimization pipeline.
- Preserve all unrelated uncommitted changes in the affected files.

## Verification

- Establish RED with `pnpm exec eslint . --max-warnings 0` while 19 warnings remain.
- Establish GREEN with the same command after implementation.
- Run `pnpm ts-check` and `git diff --check`.
- Smoke-test the running page and confirm node and asset preview areas still render without console errors.
