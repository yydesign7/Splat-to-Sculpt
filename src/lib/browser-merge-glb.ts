'use client';

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export type LayerGlbEntry = { layerName: string; url: string };

function basenameLooksGltf(segment: string): boolean {
  const s = segment.toLowerCase();
  return s.endsWith('.glb') || s.endsWith('.gltf');
}

/**
 * True if the URL likely points at a binary/embed glTF asset — required before GLTFLoader.
 * Handles normal paths (`/meshes/x.glb`) and ephemeral API URLs where the extension lives in `rel`.
 */
export function isGltfLikeUrl(url: string): boolean {
  const pathOnly = url.split('?')[0]?.toLowerCase() ?? '';
  if (basenameLooksGltf(pathOnly)) return true;

  try {
    const u = new URL(url, 'http://127.0.0.1');
    const p = u.pathname.toLowerCase();
    if (p === '/api/ephemeral-file' || p.endsWith('/api/ephemeral-file')) {
      const rel = u.searchParams.get('rel');
      if (!rel) return false;
      const last = rel.split(/[/\\]/).filter(Boolean).pop() ?? '';
      return basenameLooksGltf(last);
    }
  } catch {
    /* invalid URL */
  }
  return false;
}

function resolveAbsoluteUrl(url: string): string {
  if (url.startsWith('blob:') || url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (typeof window === 'undefined') {
    return url;
  }
  return new URL(url, window.location.origin).href;
}

function disposeObject3D(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      const mats = child.material;
      if (Array.isArray(mats)) {
        for (const m of mats) {
          m?.dispose?.();
        }
      } else {
        (mats as THREE.Material | undefined)?.dispose?.();
      }
    }
  });
}

/**
 * Load multiple per-layer GLBs, optionally dim non-highlighted layers, export one binary GLB.
 * Used only for in-browser preview (blob URLs).
 */
export async function mergeLayerGlbsInBrowser(
  layers: LayerGlbEntry[],
  highlightedLayer: string | null,
): Promise<ArrayBuffer> {
  if (layers.length === 0) {
    throw new Error('mergeLayerGlbsInBrowser: no layers');
  }

  const bad = layers.filter((l) => !isGltfLikeUrl(l.url)).map((l) => l.layerName);
  if (bad.length > 0) {
    throw new Error(
      `Browser merge only supports .glb/.gltf per layer (GLTFLoader). Non-glTF layers: ${bad.join(', ')}`,
    );
  }

  const loader = new GLTFLoader();
  const root = new THREE.Group();

  for (const { layerName, url } of layers) {
    const gltf = await loader.loadAsync(resolveAbsoluteUrl(url));
    const wrapper = new THREE.Group();
    wrapper.name = `__layer_${layerName}`;
    const sceneClone = gltf.scene.clone(true);
    wrapper.add(sceneClone);
    root.add(wrapper);

    const isHighlight = !!highlightedLayer && layerName === highlightedLayer;
    const dimOthers = !!highlightedLayer && !isHighlight;

    wrapper.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat || !('emissive' in mat) || !('opacity' in mat)) continue;
        const m = mat as THREE.MeshStandardMaterial;
        if (isHighlight) {
          m.emissive = new THREE.Color(0x3a5a7a);
          m.emissiveIntensity = 0.55;
          m.transparent = false;
          m.opacity = 1;
        } else if (dimOthers) {
          m.transparent = true;
          m.opacity = 0.28;
          m.emissive = new THREE.Color(0x000000);
          m.emissiveIntensity = 0;
        } else {
          m.transparent = false;
          m.opacity = 1;
        }
        m.needsUpdate = true;
      }
    });
  }

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('GLTFExporter did not return binary GLB');
  }
  const arrayBuffer = result;

  disposeObject3D(root);
  return arrayBuffer;
}
