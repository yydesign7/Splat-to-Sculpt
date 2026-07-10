'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';

const C0 = 0.28209479177387814;

type ParsedSplat = {
  positions: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
  scales: Float32Array;
  count: number;
};

type PlyProperty = {
  type: string;
  name: string;
  offset: number;
  size: number;
};

interface SplatViewerProps {
  splatUrl: string | null;
  className?: string;
}

function sigmoid(v: number): number {
  return 1 / (1 + Math.exp(-v));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function readValue(view: DataView, byteOffset: number, type: string): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(byteOffset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(byteOffset);
    case 'short':
    case 'int16':
      return view.getInt16(byteOffset, true);
    case 'ushort':
    case 'uint16':
      return view.getUint16(byteOffset, true);
    case 'int':
    case 'int32':
      return view.getInt32(byteOffset, true);
    case 'uint':
    case 'uint32':
      return view.getUint32(byteOffset, true);
    case 'double':
    case 'float64':
      return view.getFloat64(byteOffset, true);
    case 'float':
    case 'float32':
    default:
      return view.getFloat32(byteOffset, true);
  }
}

function plyTypeSize(type: string): number {
  switch (type) {
    case 'char':
    case 'uchar':
    case 'int8':
    case 'uint8':
      return 1;
    case 'short':
    case 'ushort':
    case 'int16':
    case 'uint16':
      return 2;
    case 'double':
    case 'float64':
      return 8;
    case 'int':
    case 'uint':
    case 'int32':
    case 'uint32':
    case 'float':
    case 'float32':
    default:
      return 4;
  }
}

function parseHeader(buffer: ArrayBuffer): {
  format: string;
  vertexCount: number;
  properties: PlyProperty[];
  payloadOffset: number;
} {
  const bytes = new Uint8Array(buffer);
  const probe = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 65536)));
  const endIndex = probe.indexOf('end_header');
  if (endIndex < 0) throw new Error('Invalid PLY: missing end_header');

  let payloadOffset = endIndex + 'end_header'.length;
  while (payloadOffset < bytes.length && (bytes[payloadOffset] === 10 || bytes[payloadOffset] === 13)) {
    payloadOffset += 1;
  }

  const header = probe.slice(0, endIndex + 'end_header'.length);
  const lines = header.split(/\r?\n/);
  let format = 'ascii';
  let vertexCount = 0;
  let inVertex = false;
  let offset = 0;
  const properties: PlyProperty[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'format') {
      format = parts[1] || 'ascii';
    } else if (parts[0] === 'element' && parts[1] === 'vertex') {
      vertexCount = Number(parts[2]) || 0;
      inVertex = true;
    } else if (parts[0] === 'element' && parts[1] !== 'vertex') {
      inVertex = false;
    } else if (inVertex && parts[0] === 'property' && parts.length >= 3) {
      const type = parts[1]!;
      const size = plyTypeSize(type);
      properties.push({ type, name: parts[2]!, offset, size });
      offset += size;
    }
  }

  return { format, vertexCount, properties, payloadOffset };
}

function parseSplatPly(buffer: ArrayBuffer): ParsedSplat {
  const { format, vertexCount, properties, payloadOffset } = parseHeader(buffer);
  if (vertexCount <= 0) throw new Error('PLY has no vertices');

  const byName = new Map(properties.map((prop) => [prop.name, prop]));
  const x = byName.get('x');
  const y = byName.get('y');
  const z = byName.get('z');
  if (!x || !y || !z) throw new Error('PLY is missing x/y/z fields');

  const f0 = byName.get('f_dc_0');
  const f1 = byName.get('f_dc_1');
  const f2 = byName.get('f_dc_2');
  const opacityProp = byName.get('opacity');
  const sx = byName.get('scale_0');
  const sy = byName.get('scale_1');
  const sz = byName.get('scale_2');
  const red = byName.get('red') || byName.get('r');
  const green = byName.get('green') || byName.get('g');
  const blue = byName.get('blue') || byName.get('b');

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const opacities = new Float32Array(vertexCount);
  const scales = new Float32Array(vertexCount);

  const writeRow = (i: number, read: (prop: PlyProperty) => number) => {
    positions[i * 3] = read(x);
    positions[i * 3 + 1] = read(y);
    positions[i * 3 + 2] = read(z);

    if (f0 && f1 && f2) {
      colors[i * 3] = clamp01(read(f0) * C0 + 0.5);
      colors[i * 3 + 1] = clamp01(read(f1) * C0 + 0.5);
      colors[i * 3 + 2] = clamp01(read(f2) * C0 + 0.5);
    } else if (red && green && blue) {
      colors[i * 3] = clamp01(read(red) / 255);
      colors[i * 3 + 1] = clamp01(read(green) / 255);
      colors[i * 3 + 2] = clamp01(read(blue) / 255);
    } else {
      colors[i * 3] = 0.72;
      colors[i * 3 + 1] = 0.66;
      colors[i * 3 + 2] = 1.0;
    }

    opacities[i] = opacityProp ? clamp01(sigmoid(read(opacityProp))) : 0.6;
    const scaleA = sx ? Math.exp(read(sx)) : 0.01;
    const scaleB = sy ? Math.exp(read(sy)) : scaleA;
    const scaleC = sz ? Math.exp(read(sz)) : scaleA;
    scales[i] = Math.max(scaleA, scaleB, scaleC, 1e-5);
  };

  if (format === 'ascii') {
    const text = new TextDecoder().decode(buffer.slice(payloadOffset));
    const rows = text.trim().split(/\r?\n/);
    for (let i = 0; i < vertexCount; i += 1) {
      const values = rows[i]?.trim().split(/\s+/).map(Number) || [];
      writeRow(i, (prop) => values[properties.indexOf(prop)] ?? 0);
    }
  } else if (format === 'binary_little_endian') {
    const view = new DataView(buffer);
    const rowSize = properties.reduce((sum, prop) => sum + prop.size, 0);
    for (let i = 0; i < vertexCount; i += 1) {
      const rowOffset = payloadOffset + i * rowSize;
      writeRow(i, (prop) => readValue(view, rowOffset + prop.offset, prop.type));
    }
  } else {
    throw new Error(`Unsupported PLY format: ${format}`);
  }

  return { positions, colors, opacities, scales, count: vertexCount };
}

function normalizeSplats(parsed: ParsedSplat): ParsedSplat {
  const { positions, scales, count } = parsed;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i += 1) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    minZ = Math.min(minZ, pz);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
    maxZ = Math.max(maxZ, pz);
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const factor = 2 / maxDim;

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (positions[i * 3] - cx) * factor;
    positions[i * 3 + 1] = (positions[i * 3 + 1] - cy) * factor;
    positions[i * 3 + 2] = (positions[i * 3 + 2] - cz) * factor;
    scales[i] = Math.max(scales[i] * factor * 2.2, 0.0025);
  }

  return parsed;
}

export default function SplatViewer({ splatUrl, className = '' }: SplatViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const frameIdRef = useRef<number>(0);
  const initDoneRef = useRef(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(splatUrl ? 'loading' : 'idle');

  const disposeThree = useCallback(() => {
    cancelAnimationFrame(frameIdRef.current);
    frameIdRef.current = 0;
    if (meshRef.current) {
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }
    controlsRef.current?.dispose();
    controlsRef.current = null;
    if (rendererRef.current) {
      rendererRef.current.dispose();
      rendererRef.current.domElement.parentElement?.removeChild(rendererRef.current.domElement);
      rendererRef.current = null;
    }
    sceneRef.current = null;
    cameraRef.current = null;
    initDoneRef.current = false;
  }, []);

  const initThree = useCallback(() => {
    const container = containerRef.current;
    if (!container || initDoneRef.current) return;

    const width = container.clientWidth || 240;
    const height = container.clientHeight || 160;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
    camera.position.set(0, 1.25, 3);
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

  useEffect(() => {
    if (!splatUrl) return;
    initThree();
  }, [initThree, splatUrl]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const renderer = rendererRef.current;
      const camera = cameraRef.current;
      if (!renderer || !camera || !container) return;
      const width = container.clientWidth || 240;
      const height = container.clientHeight || 160;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const clearMesh = () => {
      if (meshRef.current && sceneRef.current) {
        sceneRef.current.remove(meshRef.current);
        meshRef.current.geometry.dispose();
        (meshRef.current.material as THREE.Material).dispose();
        meshRef.current = null;
      }
    };

    if (!splatUrl) {
      disposeThree();
      setStatus('idle');
      return;
    }

    if (!initDoneRef.current) initThree();
    setStatus('loading');

    void (async () => {
      try {
        const response = await fetch(splatUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const parsed = normalizeSplats(parseSplatPly(buffer));
        if (cancelled) return;

        clearMesh();

        const geometry = new THREE.InstancedBufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
          -1, -1, 0,
          1, -1, 0,
          1, 1, 0,
          -1, 1, 0,
        ]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.setAttribute('instanceCenter', new THREE.InstancedBufferAttribute(parsed.positions, 3));
        geometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(parsed.colors, 3));
        geometry.setAttribute('instanceScale', new THREE.InstancedBufferAttribute(parsed.scales, 1));
        geometry.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(parsed.opacities, 1));
        geometry.instanceCount = parsed.count;

        const material = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.NormalBlending,
          vertexShader: `
            attribute vec3 instanceCenter;
            attribute vec3 instanceColor;
            attribute float instanceScale;
            attribute float instanceOpacity;
            varying vec2 vUv;
            varying vec3 vColor;
            varying float vOpacity;
            void main() {
              vUv = position.xy;
              vColor = instanceColor;
              vOpacity = instanceOpacity;
              vec4 mvCenter = modelViewMatrix * vec4(instanceCenter, 1.0);
              mvCenter.xy += position.xy * instanceScale;
              gl_Position = projectionMatrix * mvCenter;
            }
          `,
          fragmentShader: `
            precision highp float;
            varying vec2 vUv;
            varying vec3 vColor;
            varying float vOpacity;
            void main() {
              float r2 = dot(vUv, vUv);
              if (r2 > 1.0) discard;
              float alpha = exp(-r2 * 3.2) * vOpacity * 1.35;
              if (alpha < 0.01) discard;
              gl_FragColor = vec4(vColor, alpha);
            }
          `,
        });

        const mesh = new THREE.Mesh(geometry, material);
        meshRef.current = mesh;
        sceneRef.current?.add(mesh);

        if (cameraRef.current && controlsRef.current) {
          cameraRef.current.position.set(0, 1.25, 3);
          controlsRef.current.target.set(0, 0, 0);
          controlsRef.current.update();
        }

        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [splatUrl, initThree, disposeThree]);

  useEffect(() => {
    return disposeThree;
  }, [disposeThree]);

  return (
    <div
      ref={containerRef}
      className={`${className} nodrag nopan`}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {!splatUrl && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <span className="text-xs text-zinc-500">No splat</span>
        </div>
      )}
      {status === 'loading' && splatUrl && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900/50">
          <div className="flex items-center gap-2 text-xs text-[#b9a7ff]">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-[#514179] border-t-[#b9a7ff]" />
            Loading splat...
          </div>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <span className="text-xs text-red-400">Splat load failed</span>
        </div>
      )}
    </div>
  );
}
