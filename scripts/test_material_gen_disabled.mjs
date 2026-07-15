import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5001';
const routeSource = await readFile(
  new URL('../src/app/api/generate-texture/route.ts', import.meta.url),
  'utf8',
);

assert.equal(
  routeSource.includes('coze-coding-dev-sdk'),
  false,
  'Disabled Material Gen route must not import the external generation SDK',
);
assert.equal(
  routeSource.includes('.generate('),
  false,
  'Disabled Material Gen route must not contain an image-generation call',
);

const materialResponse = await fetch(`${baseUrl}/api/generate-texture`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: 'brushed aluminum' }),
});
const materialBody = await materialResponse.json();

assert.equal(materialResponse.status, 503, 'Material Gen endpoint must be disabled with HTTP 503');
assert.equal(
  materialBody.code,
  'MATERIAL_GEN_DISABLED',
  'Material Gen endpoint must return the stable disabled error code',
);

const workflowResponse = await fetch(`${baseUrl}/api/workflow-library`);
assert.equal(workflowResponse.status, 200, 'Workflow library must remain available');

const workflowBody = await workflowResponse.json();
const defaultWorkflow = workflowBody.entries?.find(
  (entry) => entry.id === 'preset_default_workflow',
);

assert.ok(defaultWorkflow, 'Default Workflow must be present');
assert.equal(
  defaultWorkflow.nodes.some((node) => node.type === 'material'),
  false,
  'Default Workflow must not contain Material Gen',
);

console.log('Material Gen disabled behavior verified.');
