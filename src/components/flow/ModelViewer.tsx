'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';

/** Convert spherical coordinates (azimuth, elevation in degrees) to cartesian (radius=5) */
function sphericalToCartesian(azimuthDeg: number, elevationDeg: number, radius = 5): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(
    radius * Math.cos(el) * Math.cos(az),
    radius * Math.sin(el),
    radius * Math.cos(el) * Math.sin(az),
  );
}

/* ---------- Main viewer props ---------- */
interface ModelViewerProps {
  modelUrl: string | null;
  modelType: 'glb' | 'fbx' | 'obj' | 'ply' | null;
  className?: string;
  /** Light parameters for real-time preview */
  lightParams?: import('./custom-nodes').LightParams;
}

/* ---------- Sanitize geometry: remove NaN positions ---------- */
function sanitizeGeometry(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const posAttr = geom.getAttribute('position');
  if (!posAttr) return geom;

  const arr = posAttr.array;

  // Check for NaN values and replace with 0
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

/* ---------- Vanilla Three.js Model Viewer ---------- */
export default function ModelViewer({ modelUrl, modelType, className = '', lightParams }: ModelViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(modelUrl ? 'loading' : 'ready');

  // Three.js objects in refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameIdRef = useRef<number>(0);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const initDoneRef = useRef(false);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const mainLightRef = useRef<THREE.DirectionalLight | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);

  const renderScene = useCallback(() => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    controlsRef.current?.update();
    renderer.render(scene, camera);
  }, []);

  const scheduleRender = useCallback(() => {
    if (frameIdRef.current) return;
    frameIdRef.current = requestAnimationFrame(() => {
      frameIdRef.current = 0;
      renderScene();
    });
  }, [renderScene]);

  const disposeThree = useCallback(() => {
    cancelAnimationFrame(frameIdRef.current);
    frameIdRef.current = 0;
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
      rendererRef.current.dispose();
      rendererRef.current.domElement.parentElement?.removeChild(rendererRef.current.domElement);
      rendererRef.current = null;
    }
    sceneRef.current = null;
    cameraRef.current = null;
    ambientLightRef.current = null;
    mainLightRef.current = null;
    fillLightRef.current = null;
    initDoneRef.current = false;
  }, [scheduleRender]);

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
  }, [scheduleRender]);

  // Effect 1: Initialize Three.js once
  useEffect(() => {
    if (!modelUrl) return;
    initThree();
  }, [initThree, modelUrl]);

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
      const mainAz = lightParams.mainLightAzimuth ?? 45;
      const mainEl = lightParams.mainLightElevation ?? 45;
      main.position.copy(sphericalToCartesian(mainAz, mainEl));
    }
    if (fill) {
      fill.intensity = lightParams.fillLightIntensity;
      const fillAz = lightParams.fillLightAzimuth ?? -135;
      const fillEl = lightParams.fillLightElevation ?? 30;
      fill.position.copy(sphericalToCartesian(fillAz, fillEl));
    }
    if (renderer) {
      renderer.toneMappingExposure = lightParams.exposure;
    }
    scheduleRender();
  }, [lightParams, scheduleRender]);

  // Effect 2: Handle resize
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
  }, [scheduleRender]);

  // Effect 3: Load model when url/type changes
  useEffect(() => {
    if (!modelUrl || !modelType) {
      disposeThree();
      setStatus('ready');
      return;
    }

    // Wait until Three.js is initialized
    if (!initDoneRef.current) {
      const timer = setTimeout(() => {
        if (!initDoneRef.current) {
          initThree();
        }
      }, 50);
      return () => clearTimeout(timer);
    }

    setStatus('loading');

    const addModelToScene = (object: THREE.Object3D) => {
      // Remove previous model
      if (modelRef.current && sceneRef.current) {
        sceneRef.current.remove(modelRef.current);
        disposeObject3D(modelRef.current);
      }

      // Step 1: Force update matrixWorld so bounding box is accurate
      object.updateMatrixWorld(true);

      // Step 2: Compute bounding box from world-space geometry
      const box = new THREE.Box3();
      object.traverse((child) => {
        if ((child instanceof THREE.Mesh || child instanceof THREE.Points) && child.geometry) {
          sanitizeGeometry(child.geometry);
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox) {
            box.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
          }
        }
      });

      // Guard against empty bounding box
      if (box.isEmpty()) {
        setStatus('error');
        return;
      }

      // Step 3: Reset root transform to get clean local-space geometry
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

      // Step 5: Apply centering and uniform scaling
      object.position.copy(localCenter.negate().multiplyScalar(finalScale));
      object.scale.set(finalScale, finalScale, finalScale);
      object.updateMatrixWorld(true);

      modelRef.current = object;

      if (sceneRef.current) {
        sceneRef.current.add(object);
      }

      // Step 6: Position camera and set controls target to origin
      if (cameraRef.current && controlsRef.current) {
        cameraRef.current.position.set(0, 1.5, 3);
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }

      setStatus('ready');
      scheduleRender();
    };

    const onError = () => {
      setStatus('error');
    };

    if (modelType === 'glb') {
      const loader = new GLTFLoader();
      loader.load(
        modelUrl,
        (gltf) => addModelToScene(gltf.scene),
        undefined,
        onError
      );
    } else if (modelType === 'fbx') {
      const loader = new FBXLoader();
      loader.load(
        modelUrl,
        addModelToScene,
        undefined,
        onError
      );
    } else if (modelType === 'obj') {
      // Try loading companion MTL file first (auto-detect)
      const mtlUrl = modelUrl.replace(/\.obj$/i, '.mtl');
      const mtlLoader = new MTLLoader();

      mtlLoader.load(
        mtlUrl,
        (materials) => {
          materials.preload();
          const loader = new OBJLoader();
          loader.setMaterials(materials);
          loader.load(modelUrl, addModelToScene, undefined, onError);
        },
        undefined,
        () => {
          // MTL not found or failed — load OBJ without materials
          // Fallback: assign MeshStandardMaterial with light gray color
          const loader = new OBJLoader();
          loader.load(modelUrl, (object) => {
            object.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                const oldMat = child.material;
                if (oldMat && !(oldMat instanceof THREE.MeshStandardMaterial)) {
                  let inheritedColor = new THREE.Color(0xaaaaaa);
                  if ('color' in oldMat && oldMat.color instanceof THREE.Color) {
                    inheritedColor = oldMat.color.clone();
                  }
                  if (inheritedColor.r === 0 && inheritedColor.g === 0 && inheritedColor.b === 0) {
                    inheritedColor.set(0xaaaaaa);
                  }
                  const newMat = new THREE.MeshStandardMaterial({
                    color: inheritedColor,
                    map: (oldMat as THREE.MeshBasicMaterial).map || null,
                    side: THREE.DoubleSide,
                    roughness: 0.6,
                    metalness: 0.1,
                  });
                  child.material = newMat;
                  oldMat.dispose();
                } else if (oldMat instanceof THREE.MeshStandardMaterial) {
                  oldMat.side = THREE.DoubleSide;
                  if (oldMat.color.r === 0 && oldMat.color.g === 0 && oldMat.color.b === 0 && !oldMat.map) {
                    oldMat.color.set(0xaaaaaa);
                  }
                }
              }
            });
            addModelToScene(object);
          }, undefined, onError);
        }
      );
    } else if (modelType === 'ply') {
      const loader = new PLYLoader();
      loader.load(
        modelUrl,
        (geometry) => {
          sanitizeGeometry(geometry);

          const hasIndex = geometry.index !== null;
          const object = new THREE.Object3D();

          if (hasIndex) {
            // PLY mesh (has triangles)
            geometry.computeVertexNormals();
            const material = new THREE.MeshStandardMaterial({
              color: 0xaaaaaa,
              metalness: 0.1,
              roughness: 0.6,
              vertexColors: geometry.hasAttribute('color'),
              side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geometry, material);
            object.add(mesh);
          } else {
            // PLY point cloud (no triangles)
            const material = new THREE.PointsMaterial({
              size: 0.02,
              vertexColors: geometry.hasAttribute('color'),
              sizeAttenuation: true,
              color: geometry.hasAttribute('color') ? 0xffffff : 0x7aaa9e,
            });
            const points = new THREE.Points(geometry, material);
            object.add(points);
          }

          addModelToScene(object);
        },
        undefined,
        onError
      );
    }
  }, [modelUrl, modelType, initThree, disposeThree, scheduleRender]);

  // Cleanup on unmount
  useEffect(() => {
    return disposeThree;
  }, [disposeThree]);

  return (
    <div
      ref={containerRef}
      className={`${className} nodrag nopan`}
      style={{ width: '100%', height: '100%', position: 'relative' }}
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
