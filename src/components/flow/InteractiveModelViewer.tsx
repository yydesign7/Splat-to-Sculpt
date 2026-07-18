'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';
import type { MaterialParams } from './custom-nodes';

/* ---------- Props ---------- */
interface InteractiveModelViewerProps {
  modelUrl: string | null;
  modelType: 'glb' | 'fbx' | 'obj' | 'ply' | null;
  className?: string;
  /** Called when user clicks a mesh layer in the model */
  onLayerClick?: (layerName: string) => void;
  /** Called when layers are detected from vertex colors after model loads */
  onLayersDetected?: (layerNames: string[]) => void;
  /** Layer name to highlight */
  highlightLayer?: string | null;
  /** Processing state overlay */
  processing?: boolean;
  processingText?: string;
  /** Light parameters for real-time preview */
  lightParams?: import('./custom-nodes').LightParams;
  /** Material parameters for immediate selected-layer preview. */
  previewMaterialParams?: MaterialParams | null;
  /** Layer that should receive previewMaterialParams; null applies to all meshes. */
  previewMaterialLayer?: string | null;
  /** Metadata-driven layer names from the workflow (takes priority over vertex color detection) */
  metadataLayerNames?: string[];
  /** Fired after this `modelUrl` has been fully added to the scene (bounding box OK, status → ready). */
  onSuccessfulModelLoad?: (loadedUrl: string) => void;
}

/* ---------- Sanitize geometry ---------- */
function sanitizeGeometry(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const posAttr = geom.getAttribute('position');
  if (!posAttr) return geom;
  const arr = posAttr.array;
  let hasNaN = false;
  for (let i = 0; i < arr.length; i++) {
    if (Number.isNaN(arr[i]) || !Number.isFinite(arr[i])) {
      arr[i] = 0;
      hasNaN = true;
    }
  }
  if (hasNaN) {
    posAttr.needsUpdate = true;
    geom.computeVertexNormals();
  }
  return geom;
}

/* ---------- Spherical to Cartesian conversion ---------- */
function sphericalToCartesian(azimuthDeg: number, elevationDeg: number, radius: number = 5): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const x = radius * Math.cos(el) * Math.sin(az);
  const y = radius * Math.sin(el);
  const z = radius * Math.cos(el) * Math.cos(az);
  return [x, y, z];
}

/* ---------- HIGHLIGHT_EMISSIVE ---------- */
const HIGHLIGHT_EMISSIVE = new THREE.Color(0x3a2a2e);

/* ---------- Color palette for layer detection (matches pointcloud_segment.py) ---------- */
const LAYER_COLOR_PALETTE: [number, number, number][] = [
  [0.90, 0.40, 0.40],  // 0: Warm Red
  [0.40, 0.70, 0.40],  // 1: Green
  [0.40, 0.55, 0.90],  // 2: Blue
  [0.90, 0.75, 0.30],  // 3: Gold
  [0.75, 0.40, 0.80],  // 4: Purple
  [0.30, 0.80, 0.75],  // 5: Teal
  [0.95, 0.55, 0.30],  // 6: Orange
  [0.55, 0.85, 0.45],  // 7: Lime
  [0.45, 0.45, 0.80],  // 8: Indigo
  [0.85, 0.55, 0.65],  // 9: Rose
  [0.65, 0.85, 0.55],  // 10: Sage
  [0.55, 0.65, 0.85],  // 11: Steel Blue
  [0.90, 0.80, 0.50],  // 12: Amber
  [0.70, 0.50, 0.75],  // 13: Mauve
  [0.50, 0.75, 0.70],  // 14: Sea Green
  [0.80, 0.60, 0.50],  // 15: Terra Cotta
];

const COLOR_MATCH_THRESHOLD = 0.12; // Max Euclidean distance for color matching

/** Match an RGB color to the closest palette entry, returning the layer index or -1 */
function matchVertexColorToLayer(r: number, g: number, b: number): number {
  let bestIdx = -1;
  let bestDist = COLOR_MATCH_THRESHOLD;
  for (let i = 0; i < LAYER_COLOR_PALETTE.length; i++) {
    const [pr, pg, pb] = LAYER_COLOR_PALETTE[i];
    const dist = Math.sqrt((r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Scan a model's vertex colors and return a mapping: layerIndex → layerName */
function detectLayersFromVertexColors(object: THREE.Object3D): Map<number, string> {
  const layerSet = new Map<number, string>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const geom = child.geometry;
      const colorAttr = geom.getAttribute('color');
      if (colorAttr) {
        // Sample up to 500 vertices to find distinct layer colors
        const step = Math.max(1, Math.floor(colorAttr.count / 500));
        for (let i = 0; i < colorAttr.count; i += step) {
          const r = colorAttr.getX(i);
          const g = colorAttr.getY(i);
          const b = colorAttr.getZ(i);
          const layerIdx = matchVertexColorToLayer(r, g, b);
          if (layerIdx >= 0 && !layerSet.has(layerIdx)) {
            layerSet.set(layerIdx, `Layer ${layerIdx}`);
          }
        }
      }
    }
  });
  return layerSet;
}

/* ---------- Store original material props for highlight restoration ---------- */
const originalMaterialProps = new WeakMap<THREE.MeshStandardMaterial, {
  emissive: THREE.Color;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
}>();

function saveOriginalMaterial(mat: THREE.MeshStandardMaterial) {
  if (!originalMaterialProps.has(mat)) {
    originalMaterialProps.set(mat, {
      emissive: mat.emissive.clone(),
      emissiveIntensity: mat.emissiveIntensity,
      opacity: mat.opacity,
      transparent: mat.transparent,
    });
  }
}

function restoreMaterial(mat: THREE.MeshStandardMaterial) {
  const orig = originalMaterialProps.get(mat);
  if (orig) {
    mat.emissive.copy(orig.emissive);
    mat.emissiveIntensity = orig.emissiveIntensity;
    mat.opacity = orig.opacity;
    mat.transparent = orig.transparent;
  }
}

function setRestorableMaterialState(mat: THREE.MeshStandardMaterial) {
  originalMaterialProps.set(mat, {
    emissive: mat.emissive.clone(),
    emissiveIntensity: mat.emissiveIntensity,
    opacity: mat.opacity,
    transparent: mat.transparent,
  });
}

function applyPreviewMaterial(mat: THREE.MeshStandardMaterial, params: MaterialParams) {
  if (params.base_color_modified) {
    mat.color.setRGB(params.base_color[0], params.base_color[1], params.base_color[2]);
  }
  mat.metalness = params.metallic;
  mat.roughness = params.roughness;
  mat.emissive.setRGB(params.emissive_color[0], params.emissive_color[1], params.emissive_color[2]);
  mat.emissiveIntensity = params.emissive_strength;
  mat.opacity = params.alpha;
  mat.transparent = params.alpha < 0.999;
  mat.needsUpdate = true;
  setRestorableMaterialState(mat);
}

function standardMaterials(material: THREE.Material | THREE.Material[]): THREE.MeshStandardMaterial[] {
  const materials = Array.isArray(material) ? material : [material];
  return materials.filter((mat): mat is THREE.MeshStandardMaterial => mat instanceof THREE.MeshStandardMaterial);
}

/* ---------- Interactive Model Viewer ---------- */
export default function InteractiveModelViewer({
  modelUrl,
  modelType,
  className = '',
  onLayerClick,
  onLayersDetected,
  highlightLayer,
  processing = false,
  processingText = 'Processing...',
  lightParams,
  previewMaterialParams,
  previewMaterialLayer,
  metadataLayerNames,
  onSuccessfulModelLoad,
}: InteractiveModelViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Incremented on each new load so stale loader callbacks cannot flip status to error/ready */
  const loadSeqRef = useRef(0);
  const modelUrlRef = useRef<string | null>(modelUrl);
  useEffect(() => {
    modelUrlRef.current = modelUrl;
  }, [modelUrl]);

  const onSuccessfulModelLoadRef = useRef(onSuccessfulModelLoad);
  useEffect(() => {
    onSuccessfulModelLoadRef.current = onSuccessfulModelLoad;
  }, [onSuccessfulModelLoad]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(modelUrl ? 'loading' : 'ready');
  const onLayersDetectedRef = useRef(onLayersDetected);
  useEffect(() => { onLayersDetectedRef.current = onLayersDetected; }, [onLayersDetected]);

  // Store metadata layer names in a ref so the click handler can use them
  const metadataLayerNamesRef = useRef<string[] | undefined>(metadataLayerNames);
  useEffect(() => { metadataLayerNamesRef.current = metadataLayerNames; }, [metadataLayerNames]);

  // Map: mesh.name → metadata layer name (built during model load)
  const meshToLayerMapRef = useRef<Map<string, string>>(new Map());

  // Three.js objects in refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameIdRef = useRef<number>(0);
  const interactionFrameIdRef = useRef<number>(0);
  const isInteractionRenderingRef = useRef(false);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const initDoneRef = useRef(false);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const pointerRef = useRef<THREE.Vector2>(new THREE.Vector2());
  const highlightLayerRef = useRef<string | null>(null);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const mainLightRef = useRef<THREE.DirectionalLight | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);
  const previewMaterialParamsRef = useRef<MaterialParams | null>(previewMaterialParams ?? null);
  const previewMaterialLayerRef = useRef<string | null>(previewMaterialLayer ?? null);

  const applyVisualState = useCallback(() => {
    const model = modelRef.current;
    const targetName = highlightLayerRef.current;
    const previewParams = previewMaterialParamsRef.current;
    const previewLayer = previewMaterialLayerRef.current;
    const meshMap = meshToLayerMapRef.current;
    if (!model) return;

    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.material) return;
      const mats = standardMaterials(child.material);
      if (mats.length === 0) return;

      const mappedLayer = meshMap.get(child.name);
      const matchesPreviewLayer = !previewLayer || mappedLayer === previewLayer || child.name === previewLayer;
      const isHighlighted = !!targetName && (mappedLayer === targetName || child.name === targetName);

      for (const mat of mats) {
        if (previewParams && matchesPreviewLayer) {
          applyPreviewMaterial(mat, previewParams);
        } else {
          saveOriginalMaterial(mat);
        }

        if (isHighlighted) {
          mat.emissive.copy(HIGHLIGHT_EMISSIVE);
          mat.emissiveIntensity = 0.5;
          mat.opacity = 1.0;
          mat.transparent = false;
        } else if (targetName) {
          mat.opacity = 0.3;
          mat.transparent = true;
          mat.emissive.set(0x000000);
          mat.emissiveIntensity = 0;
        } else {
          restoreMaterial(mat);
        }
      }
    });
  }, []);

  const renderScene = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    controlsRef.current?.update();
    applyVisualState();
    renderer.render(scene, camera);
  }, [applyVisualState]);

  const scheduleRender = useCallback(() => {
    if (frameIdRef.current) return;
    frameIdRef.current = requestAnimationFrame(() => {
      frameIdRef.current = 0;
      renderScene();
    });
  }, [renderScene]);

  const scheduleRenderBurst = useCallback((frameCount = 6) => {
    let remaining = frameCount;
    const tick = () => {
      renderScene();
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [renderScene]);

  const startInteractionRenderLoop = useCallback(() => {
    if (isInteractionRenderingRef.current) return;
    isInteractionRenderingRef.current = true;

    const tick = () => {
      if (!isInteractionRenderingRef.current) {
        interactionFrameIdRef.current = 0;
        return;
      }
      renderScene();
      interactionFrameIdRef.current = requestAnimationFrame(tick);
    };

    interactionFrameIdRef.current = requestAnimationFrame(tick);
  }, [renderScene]);

  const stopInteractionRenderLoop = useCallback(() => {
    isInteractionRenderingRef.current = false;
    if (interactionFrameIdRef.current) {
      cancelAnimationFrame(interactionFrameIdRef.current);
      interactionFrameIdRef.current = 0;
    }
    scheduleRender();
  }, [scheduleRender]);

  // Track highlight layer in ref for use in animation loop
  useEffect(() => {
    highlightLayerRef.current = highlightLayer ?? null;
    scheduleRender();
  }, [highlightLayer, scheduleRender]);

  useEffect(() => {
    previewMaterialParamsRef.current = previewMaterialParams ?? null;
    scheduleRender();
  }, [previewMaterialParams, scheduleRender]);

  useEffect(() => {
    previewMaterialLayerRef.current = previewMaterialLayer ?? null;
    scheduleRender();
  }, [previewMaterialLayer, scheduleRender]);

  // Effect: Apply lightParams to Three.js lights in real-time
  useEffect(() => {
    if (!lightParams) return;
    const ambient = ambientLightRef.current;
    const main = mainLightRef.current;
    const fill = fillLightRef.current;
    const renderer = rendererRef.current;

    if (ambient) {
      ambient.intensity = lightParams.ambientIntensity;
    }
    if (main) {
      main.intensity = lightParams.mainLightIntensity;
      main.color.setRGB(lightParams.mainLightColor[0], lightParams.mainLightColor[1], lightParams.mainLightColor[2]);
      // Update main light direction from azimuth/elevation
      const [x, y, z] = sphericalToCartesian(lightParams.mainLightAzimuth, lightParams.mainLightElevation);
      main.position.set(x, y, z);
    }
    if (fill) {
      fill.intensity = lightParams.fillLightIntensity;
      // Update fill light direction from azimuth/elevation
      const [x, y, z] = sphericalToCartesian(lightParams.fillLightAzimuth, lightParams.fillLightElevation);
      fill.position.set(x, y, z);
    }
    if (renderer) {
      renderer.toneMappingExposure = lightParams.exposure;
    }
    scheduleRender();
  }, [lightParams, scheduleRender]);

  // Initialize Three.js scene
  const initThree = useCallback(() => {
    const container = containerRef.current;
    if (!container || initDoneRef.current) return;

    const width = container.clientWidth || 200;
    const height = container.clientHeight || 200;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
    camera.position.set(0, 0, 3);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.addEventListener('change', scheduleRender);
    renderer.domElement.addEventListener('pointerdown', startInteractionRenderLoop);
    window.addEventListener('pointerup', stopInteractionRenderLoop);
    window.addEventListener('pointercancel', stopInteractionRenderLoop);
    window.addEventListener('blur', stopInteractionRenderLoop);
    controlsRef.current = controls;

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    ambientLightRef.current = ambient;
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dir1.position.set(5, 5, 5);
    scene.add(dir1);
    mainLightRef.current = dir1;
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-5, 5, -5);
    scene.add(dir2);
    fillLightRef.current = dir2;

    initDoneRef.current = true;
    scheduleRender();
  }, [scheduleRender, startInteractionRenderLoop, stopInteractionRenderLoop]);

  // Effect: Initialize Three.js once
  useEffect(() => {
    initThree();
  }, [initThree]);

  // Effect: Handle resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (!renderer || !camera || !container) return;

      const width = container.clientWidth || 200;
      const height = container.clientHeight || 200;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      scheduleRender();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [scheduleRender, startInteractionRenderLoop, stopInteractionRenderLoop]);

  // Effect: Load model when url/type changes
  useEffect(() => {
    if (!modelUrl || !modelType) {
      loadSeqRef.current += 1;
      if (modelRef.current && sceneRef.current) {
        sceneRef.current.remove(modelRef.current);
        disposeObject3D(modelRef.current);
        modelRef.current = null;
      }
      setStatus('ready');
      return;
    }

    if (!initDoneRef.current) {
      const timer = setTimeout(() => {
        if (!initDoneRef.current) {
          initThree();
        }
      }, 50);
      return () => clearTimeout(timer);
    }

    const loadTargetUrl = modelUrl;
    const seq = ++loadSeqRef.current;
    setStatus('loading');

    const addModelToScene = (object: THREE.Object3D) => {
      if (seq !== loadSeqRef.current) {
        disposeObject3D(object);
        return;
      }
      if (modelRef.current && sceneRef.current) {
        sceneRef.current.remove(modelRef.current);
        disposeObject3D(modelRef.current);
      }

      // Collect layer names and ensure materials are MeshStandardMaterial
      // First, detect layers from vertex colors if present
      const vertexColorLayers = detectLayersFromVertexColors(object);
      const hasVertexColors = vertexColorLayers.size > 0;
      const names: string[] = [];
      const meshToLayerMap = new Map<string, string>();
      const currentMetadataLayerNames = metadataLayerNamesRef.current;

      // Determine which layer name source to use
      // metadataLayerNames (from workflow metadata) takes priority over vertex color detection
      const useMetadataLayers = currentMetadataLayerNames && currentMetadataLayerNames.length > 0;

      if (useMetadataLayers) {
        // Use metadata-driven layer names as the source of truth
        for (const name of currentMetadataLayerNames) {
          names.push(name);
        }
      } else if (hasVertexColors) {
        // Add layer names from vertex color detection
        const sortedIndices = Array.from(vertexColorLayers.keys()).sort((a, b) => a - b);
        for (const idx of sortedIndices) {
          const name = vertexColorLayers.get(idx)!;
          names.push(name);
        }
      }

      object.traverse((child) => {
        if (child instanceof THREE.Mesh && child.geometry) {
          sanitizeGeometry(child.geometry);

          // Force compute vertex normals — many OBJ files lack normals,
          // and MeshStandardMaterial requires normals for lighting.
          // Without normals, the model renders as completely black.
          child.geometry.computeVertexNormals();

          const colorAttr = child.geometry.getAttribute('color');

          // Ensure MeshStandardMaterial for proper highlighting
          if (!Array.isArray(child.material)) {
            const oldMat = child.material;
            if (!(oldMat instanceof THREE.MeshStandardMaterial)) {
              // Inherit color from old material, fallback to light gray
              let inheritedColor = new THREE.Color(0xaaaaaa);
              if (oldMat && 'color' in oldMat && oldMat.color instanceof THREE.Color) {
                inheritedColor = oldMat.color.clone();
              }
              // Check if the inherited color is pure black — likely a missing-material fallback
              if (inheritedColor.r === 0 && inheritedColor.g === 0 && inheritedColor.b === 0) {
                inheritedColor.set(0xaaaaaa);
              }

              const newMat = new THREE.MeshStandardMaterial({
                color: inheritedColor,
                map: (oldMat as THREE.MeshBasicMaterial).map || null,
                side: THREE.DoubleSide,
                roughness: 0.6,
                metalness: 0.1,
                vertexColors: !!colorAttr,
              });
              // If vertex colors exist, use white as base so vertex colors show through
              if (colorAttr) {
                newMat.color.set(0xffffff);
              }
              child.material = newMat;
              oldMat.dispose();
            } else {
              const stdMat = child.material as THREE.MeshStandardMaterial;
              stdMat.side = THREE.DoubleSide;
              // Fix pure-black diffuse color on MeshStandardMaterial too
              if (stdMat.color.r === 0 && stdMat.color.g === 0 && stdMat.color.b === 0 && !stdMat.map && !colorAttr) {
                stdMat.color.set(0xaaaaaa);
              }
              // Enable vertex colors if present
              if (colorAttr) {
                stdMat.vertexColors = true;
                stdMat.color.set(0xffffff);
              }
            }
          }

          // For models without vertex colors and no metadata layers, use mesh name as layer name
          // When metadata layers exist, build a mapping from mesh.name → metadata layer name
          if (useMetadataLayers) {
            // Assign metadata layer names to meshes
            // Strategy: if there are N metadata layers and M meshes, map them in order
            // For single-mesh models, the entire model gets the first metadata layer name
            if (!child.name) {
              child.name = `mesh_${names.length}`;
            }
            // Map this mesh to its corresponding metadata layer
            // If there's only 1 mesh and multiple layers, map all layers to that mesh
            // If there are multiple meshes, map by order
            const meshList: THREE.Mesh[] = [];
            object.traverse((c) => {
              if (c instanceof THREE.Mesh) meshList.push(c);
            });
            const meshIndex = meshList.indexOf(child);
            if (meshIndex >= 0 && meshIndex < names.length) {
              meshToLayerMap.set(child.name, names[meshIndex]);
            } else if (names.length > 0) {
              meshToLayerMap.set(child.name, names[0]);
            }
          } else if (!hasVertexColors) {
            const layerName = child.name || child.parent?.name || `Layer_${names.length}`;
            if (child.name && !names.includes(child.name)) {
              names.push(child.name);
            } else if (!child.name) {
              child.name = layerName;
              if (!names.includes(layerName)) {
                names.push(layerName);
              }
            }
          } else {
            // For vertex-color models, assign a generic name based on vertex color layers
            if (!child.name) {
              child.name = `vc_mesh_${names.length}`;
            }
          }
        }
      });

      if (seq !== loadSeqRef.current) {
        disposeObject3D(object);
        return;
      }

      meshToLayerMapRef.current = meshToLayerMap;
      onLayersDetectedRef.current?.(names);

      // Step 1: Force update matrixWorld so bounding box is accurate
      object.updateMatrixWorld(true);

      // Step 2: Compute bounding box from world-space geometry
      const box = new THREE.Box3();
      object.traverse((child) => {
        if ((child instanceof THREE.Mesh || child instanceof THREE.Points) && child.geometry) {
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox) {
            box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
          }
        }
      });

      // Guard against empty bounding box
      if (box.isEmpty()) {
        disposeObject3D(object);
        if (seq === loadSeqRef.current && loadTargetUrl === modelUrlRef.current) {
          setStatus('error');
        }
        return;
      }

      // Step 3: Reset root transform, then apply centering & scaling
      // This avoids stale matrixWorld from loaders
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, 0);
      object.scale.set(1, 1, 1);
      object.updateMatrixWorld(true);

      // Step 4: Recompute bounding box from clean local-space geometry
      const localBox = new THREE.Box3();
      object.traverse((child) => {
        if ((child instanceof THREE.Mesh || child instanceof THREE.Points) && child.geometry) {
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox) {
            localBox.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
          }
        }
      });

      const localCenter = new THREE.Vector3();
      localBox.getCenter(localCenter);
      const localSize = new THREE.Vector3();
      localBox.getSize(localSize);
      const localMaxDim = Math.max(localSize.x, localSize.y, localSize.z);
      const finalScale = localMaxDim > 0 && Number.isFinite(localMaxDim) ? 2 / localMaxDim : 1;

      // Step 5: Apply centering (move geometry center to origin) and uniform scaling
      object.position.copy(localCenter.negate().multiplyScalar(finalScale));
      object.scale.set(finalScale, finalScale, finalScale);
      object.updateMatrixWorld(true);

      if (seq !== loadSeqRef.current) {
        disposeObject3D(object);
        return;
      }

      modelRef.current = object;

      if (sceneRef.current) {
        sceneRef.current.add(object);
      }

      // Step 6: Position camera and set controls target to origin
      if (cameraRef.current && controlsRef.current) {
        cameraRef.current.position.set(0, 1.5, 3);
        cameraRef.current.near = 0.001;
        cameraRef.current.far = 10000;
        cameraRef.current.updateProjectionMatrix();
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }

      if (seq === loadSeqRef.current) {
        onSuccessfulModelLoadRef.current?.(loadTargetUrl);
      }
      setStatus('ready');
      scheduleRender();
      scheduleRenderBurst();
    };

    const onError = () => {
      if (seq !== loadSeqRef.current) return;
      if (loadTargetUrl !== modelUrlRef.current) return;
      setStatus('error');
    };

    if (modelType === 'glb') {
      const loader = new GLTFLoader();
      loader.load(
        modelUrl,
        (gltf) => {
          if (seq !== loadSeqRef.current) {
            disposeObject3D(gltf.scene);
            return;
          }
          addModelToScene(gltf.scene);
        },
        undefined,
        onError,
      );
    } else if (modelType === 'fbx') {
      const loader = new FBXLoader();
      loader.load(
        modelUrl,
        (obj) => {
          if (seq !== loadSeqRef.current) {
            disposeObject3D(obj);
            return;
          }
          addModelToScene(obj);
        },
        undefined,
        onError,
      );
    } else if (modelType === 'obj') {
      // Try loading companion MTL file first
      const mtlUrl = modelUrl.replace(/\.obj$/i, '.mtl');
      const mtlLoader = new MTLLoader();

      mtlLoader.load(
        mtlUrl,
        (materials) => {
          if (seq !== loadSeqRef.current) return;
          materials.preload();
          const loader = new OBJLoader();
          loader.setMaterials(materials);
          loader.load(
            modelUrl,
            (obj) => {
              if (seq !== loadSeqRef.current) {
                disposeObject3D(obj);
                return;
              }
              addModelToScene(obj);
            },
            undefined,
            onError,
          );
        },
        undefined,
        () => {
          if (seq !== loadSeqRef.current) return;
          // MTL not found or failed — load OBJ without materials
          const loader = new OBJLoader();
          loader.load(
            modelUrl,
            (obj) => {
              if (seq !== loadSeqRef.current) {
                disposeObject3D(obj);
                return;
              }
              addModelToScene(obj);
            },
            undefined,
            onError,
          );
        },
      );
    } else if (modelType === 'ply') {
      const loader = new PLYLoader();
      loader.load(
        modelUrl,
        (geometry) => {
          if (seq !== loadSeqRef.current) {
            geometry.dispose();
            return;
          }
          sanitizeGeometry(geometry);

          const object = new THREE.Object3D();
          if (geometry.index) {
            geometry.computeVertexNormals();
            const material = new THREE.MeshStandardMaterial({
              color: geometry.hasAttribute('color') ? 0xffffff : 0xaaaaaa,
              metalness: 0.1,
              roughness: 0.6,
              vertexColors: geometry.hasAttribute('color'),
              side: THREE.DoubleSide,
            });
            object.add(new THREE.Mesh(geometry, material));
          } else {
            const material = new THREE.PointsMaterial({
              size: 0.02,
              vertexColors: geometry.hasAttribute('color'),
              sizeAttenuation: true,
              color: geometry.hasAttribute('color') ? 0xffffff : 0x7aaa9e,
            });
            object.add(new THREE.Points(geometry, material));
          }
          addModelToScene(object);
        },
        undefined,
        onError,
      );
    } else if (seq === loadSeqRef.current && loadTargetUrl === modelUrlRef.current) {
      setStatus('error');
    }
  }, [modelUrl, modelType, initThree, scheduleRender, scheduleRenderBurst]);

  // Handle click for layer selection
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onLayerClick || !modelRef.current || !cameraRef.current || !containerRef.current) return;

      const container = containerRef.current;
      const rect = container.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      pointerRef.current.set(x, y);
      raycasterRef.current.setFromCamera(pointerRef.current, cameraRef.current);

      const intersects = raycasterRef.current.intersectObject(modelRef.current, true);

      if (intersects.length > 0) {
        const hit = intersects[0];
        const mesh = hit.object as THREE.Mesh;
        const meshName = mesh.name;

        // Priority 1: If metadata layer names are available, map mesh name → metadata layer name
        const metadataLayers = metadataLayerNamesRef.current;
        if (metadataLayers && metadataLayers.length > 0) {
          const mappedName = meshToLayerMapRef.current.get(meshName);
          if (mappedName) {
            onLayerClick(mappedName);
            return;
          }
          // If no mapping found but we have metadata layers, default to first layer
          // (the entire model is composed of these layers)
          if (metadataLayers.length === 1) {
            onLayerClick(metadataLayers[0]);
            return;
          }
          // Multiple metadata layers — try to determine which layer by vertex color
          const geom = mesh.geometry;
          const colorAttr = geom.getAttribute('color');
          if (colorAttr && hit.faceIndex !== undefined && hit.faceIndex !== null) {
            const face = hit.face;
            if (face) {
              const vertexIndex = face.a;
              const r = colorAttr.getX(vertexIndex);
              const g = colorAttr.getY(vertexIndex);
              const b = colorAttr.getZ(vertexIndex);
              const layerIdx = matchVertexColorToLayer(r, g, b);
              if (layerIdx >= 0 && layerIdx < metadataLayers.length) {
                onLayerClick(metadataLayers[layerIdx]);
                return;
              }
            }
          }
          // Fallback: can't determine specific layer, click the first one
          onLayerClick(metadataLayers[0]);
          return;
        }

        // Priority 2: Vertex-color-based layer detection (no metadata layers)
        const geom = mesh.geometry;
        const colorAttr = geom.getAttribute('color');
        if (colorAttr && hit.faceIndex !== undefined && hit.faceIndex !== null) {
          const face = hit.face;
          if (face) {
            // Get vertex color from the first vertex of the hit face
            const vertexIndex = face.a;
            const r = colorAttr.getX(vertexIndex);
            const g = colorAttr.getY(vertexIndex);
            const b = colorAttr.getZ(vertexIndex);
            const layerIdx = matchVertexColorToLayer(r, g, b);
            if (layerIdx >= 0) {
              onLayerClick(`Layer ${layerIdx}`);
              return;
            }
          }
        }

        // Priority 3: Fallback to mesh name
        let layerName = meshName;
        if (!layerName && mesh.parent) {
          layerName = mesh.parent.name;
        }
        if (layerName) {
          onLayerClick(layerName);
        }
      }
    },
    [onLayerClick]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(frameIdRef.current);
      isInteractionRenderingRef.current = false;
      if (interactionFrameIdRef.current) {
        cancelAnimationFrame(interactionFrameIdRef.current);
        interactionFrameIdRef.current = 0;
      }
      if (modelRef.current) {
        disposeObject3D(modelRef.current);
        modelRef.current = null;
      }
      if (controlsRef.current) {
        controlsRef.current.removeEventListener('change', scheduleRender);
        controlsRef.current.dispose();
        controlsRef.current = null;
      }
      if (rendererRef.current) {
        rendererRef.current.domElement.removeEventListener('pointerdown', startInteractionRenderLoop);
        window.removeEventListener('pointerup', stopInteractionRenderLoop);
        window.removeEventListener('pointercancel', stopInteractionRenderLoop);
        window.removeEventListener('blur', stopInteractionRenderLoop);
        rendererRef.current.dispose();
        if (rendererRef.current.domElement.parentElement) {
          rendererRef.current.domElement.parentElement.removeChild(rendererRef.current.domElement);
        }
        rendererRef.current = null;
      }
      sceneRef.current = null;
      cameraRef.current = null;
      initDoneRef.current = false;
    };
  }, [scheduleRender, startInteractionRenderLoop, stopInteractionRenderLoop]);

  return (
    <div
      ref={containerRef}
      className={`${className} nodrag nopan`}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onClick={handleClick}
    >
      {!modelUrl && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <span className="text-xs text-zinc-500">No model</span>
        </div>
      )}
      {status === 'loading' && modelUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/50 z-10">
          <div className="flex items-center gap-2 text-xs text-[#9a6a74]">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#7a4a55] border-t-[#9a6a74]" />
            Loading model...
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <span className="text-xs text-red-400">Model load failed</span>
        </div>
      )}
      {processing && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/70 z-20">
          <div className="flex items-center gap-2 text-xs text-[#9a6a74]">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#7a4a55] border-t-[#9a6a74]" />
            {processingText}
          </div>
        </div>
      )}
      {highlightLayer && modelUrl && !processing && (
        <div className="absolute left-1 top-1 z-10 rounded bg-zinc-900/80 px-1.5 py-0.5 text-[9px] text-[#9a8aaa]">
          Selected: {highlightLayer}
        </div>
      )}
    </div>
  );
}

/* ---------- Dispose Object3D recursively ---------- */
function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material?.dispose();
      }
    }
    if (child instanceof THREE.Points) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material?.dispose();
      }
    }
  });
}
