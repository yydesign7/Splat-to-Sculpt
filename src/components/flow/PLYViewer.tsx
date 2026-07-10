'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';

/* ---------- Sanitize PLY geometry ---------- */
function sanitizeGeometry(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  const keepAttrs = new Set(['position', 'color']);
  const attrNames = Object.keys(geom.attributes);
  for (const name of attrNames) {
    if (!keepAttrs.has(name)) {
      geom.deleteAttribute(name);
    }
  }

  if (geom.hasAttribute('color')) {
    const colorAttr = geom.getAttribute('color') as THREE.BufferAttribute;
    const srcArray = colorAttr.array;
    const srcItemSize = colorAttr.itemSize;
    const vertexCount = colorAttr.count;
    const dst = new Float32Array(vertexCount * 3);

    if (srcArray instanceof Float32Array && srcItemSize === 3) {
      dst.set(srcArray);
    } else {
      for (let i = 0; i < vertexCount; i++) {
        const r = srcArray[i * srcItemSize];
        const g = srcArray[i * srcItemSize + 1];
        const b = srcArray[i * srcItemSize + 2];

        if (srcArray instanceof Uint8Array || srcArray instanceof Uint16Array) {
          const maxVal = srcArray instanceof Uint8Array ? 255 : 65535;
          dst[i * 3] = r / maxVal;
          dst[i * 3 + 1] = g / maxVal;
          dst[i * 3 + 2] = b / maxVal;
        } else {
          dst[i * 3] = r;
          dst[i * 3 + 1] = g;
          dst[i * 3 + 2] = b;
        }
      }
    }

    geom.setAttribute('color', new THREE.BufferAttribute(dst, 3));
  }

  return geom;
}

/* ---------- Main viewer props ---------- */
interface PLYViewerProps {
  plyUrl: string | null;
  className?: string;
}

/* ---------- Vanilla Three.js PLY Viewer ---------- */
export default function PLYViewer({ plyUrl, className = '' }: PLYViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(plyUrl ? 'loading' : 'ready');

  // Three.js objects in refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameIdRef = useRef<number>(0);
  const pointsRef = useRef<THREE.Points | null>(null);
  const initDoneRef = useRef(false);

  const disposeThree = useCallback(() => {
    cancelAnimationFrame(frameIdRef.current);
    frameIdRef.current = 0;
    if (pointsRef.current) {
      pointsRef.current.geometry.dispose();
      (pointsRef.current.material as THREE.Material).dispose();
      pointsRef.current = null;
    }
    if (controlsRef.current) {
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
    initDoneRef.current = false;
  }, []);

  // Initialize Three.js scene — always called after container is mounted
  const initThree = useCallback(() => {
    const container = containerRef.current;
    if (!container || initDoneRef.current) return;

    const width = container.clientWidth || 200;
    const height = container.clientHeight || 200;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
    camera.position.set(0, 0, 3);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;

    const animate = () => {
      frameIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    initDoneRef.current = true;
  }, []);

  // Effect 1: Initialize Three.js once the container div is in the DOM
  useEffect(() => {
    if (!plyUrl) return;
    initThree();
  }, [initThree, plyUrl]);

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
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Effect 3: Load PLY when plyUrl changes
  useEffect(() => {
    if (!plyUrl) {
      disposeThree();
      setStatus('ready');
      return;
    }

    // Wait until Three.js is initialized before loading
    if (!initDoneRef.current) {
      // Try again after a short delay (container might not be ready yet)
      const timer = setTimeout(() => {
        if (!initDoneRef.current) {
          initThree();
        }
        // Trigger reload by not returning — let the effect re-run logic happen inline
      }, 50);
      return () => clearTimeout(timer);
    }

    setStatus('loading');

    const loader = new PLYLoader();
    loader.load(
      plyUrl,
      (loadedGeometry) => {
        // Remove previous points
        if (pointsRef.current && sceneRef.current) {
          sceneRef.current.remove(pointsRef.current);
          pointsRef.current.geometry.dispose();
          (pointsRef.current.material as THREE.Material).dispose();
        }

        // Center and normalize
        loadedGeometry.computeBoundingBox();
        const box = loadedGeometry.boundingBox!;
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = maxDim > 0 ? 2 / maxDim : 1;

        loadedGeometry.translate(-center.x, -center.y, -center.z);
        loadedGeometry.scale(scale, scale, scale);

        sanitizeGeometry(loadedGeometry);

        const hasColors = loadedGeometry.hasAttribute('color');
        const material = new THREE.PointsMaterial({
          size: 0.02,
          vertexColors: hasColors,
          sizeAttenuation: true,
          color: hasColors ? 0xffffff : 0x7aaa9e,
        });

        const points = new THREE.Points(loadedGeometry, material);
        pointsRef.current = points;

        if (sceneRef.current) {
          sceneRef.current.add(points);
        }

        // Position camera and set controls target to origin
        if (cameraRef.current && controlsRef.current) {
          cameraRef.current.position.set(0, 1.5, 3);
          controlsRef.current.target.set(0, 0, 0);
          controlsRef.current.update();
        }

        setStatus('ready');
      },
      undefined,
      () => {
        setStatus('error');
      }
    );
  }, [plyUrl, initThree, disposeThree]);

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
      {!plyUrl && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <span className="text-xs text-zinc-500">No point cloud</span>
        </div>
      )}
      {status === 'loading' && plyUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/50 z-10">
          <div className="flex items-center gap-2 text-xs text-[#7aaa9e]">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#4a6a64] border-t-[#7aaa9e]" />
            Loading point cloud...
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <span className="text-xs text-red-400">Point cloud load failed</span>
        </div>
      )}
    </div>
  );
}
