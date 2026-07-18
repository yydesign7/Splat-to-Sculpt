import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve('src/components/flow/InteractiveModelViewer.tsx');
const source = readFileSync(sourcePath, 'utf8');

const requirements = [
  {
    name: 'starts an interaction render loop while the pointer is down',
    pattern: /startInteractionRenderLoop/,
  },
  {
    name: 'stops the interaction render loop when interaction ends',
    pattern: /stopInteractionRenderLoop/,
  },
  {
    name: 'binds pointerdown on the renderer canvas',
    pattern: /addEventListener\('pointerdown',\s*startInteractionRenderLoop\)/,
  },
  {
    name: 'binds pointerup on window so releasing outside the preview stops rendering',
    pattern: /window\.addEventListener\('pointerup',\s*stopInteractionRenderLoop\)/,
  },
  {
    name: 'cleans up pointer listeners on unmount',
    pattern: /removeEventListener\('pointerdown',\s*startInteractionRenderLoop\)/,
  },
];

const failures = requirements.filter((requirement) => !requirement.pattern.test(source));

if (failures.length > 0) {
  console.error('InteractiveModelViewer drag rendering regression check failed:');
  for (const failure of failures) {
    console.error(`- Missing: ${failure.name}`);
  }
  process.exit(1);
}

console.log('InteractiveModelViewer drag rendering behavior verified.');
