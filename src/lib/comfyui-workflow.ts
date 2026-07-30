export type ComfyWorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type ComfyApiWorkflow = Record<string, ComfyWorkflowNode>;

export interface ComfyVideoPreset {
  comfyUrl: string;
  model: string;
  prompt: string;
  videoResolution: string;
  ratio: string;
  duration: number;
  generateAudio: boolean;
  seed: number;
  watermark: boolean;
  sceneSelection: string;
  renderResolution: number;
  background: string;
  cameraElevation: number;
  framePadding: number;
  renderEngine: string;
  forceRender: boolean;
  filenamePrefix: string;
  format: string;
  codec: string;
}

export interface ComfyVideoRunSettings extends Partial<ComfyVideoPreset> {
  comfyUrl?: string;
  comfyInput3dDir?: string;
}

export interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyDetectedFolders {
  baseDir: string | null;
  inputDir: string | null;
  outputDir: string | null;
  input3dDir: string | null;
}

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8000';

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '/' || /^[A-Za-z]:[\\/]*$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function joinPath(base: string | null, child: string): string | null {
  const cleanedBase = cleanPath(base);
  if (!cleanedBase) return null;
  if (cleanedBase === '/') return `/${child}`;
  return `${cleanedBase}/${child}`;
}

function dirnameOf(value: string): string | null {
  const slashIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (slashIndex < 0) return null;
  if (slashIndex === 0) return '/';
  return cleanPath(value.slice(0, slashIndex));
}

function getSystemArgv(systemStats: unknown): string[] {
  if (!systemStats || typeof systemStats !== 'object') return [];
  const system = (systemStats as Record<string, unknown>).system;
  if (!system || typeof system !== 'object') return [];
  const argv = (system as Record<string, unknown>).argv;
  return Array.isArray(argv) ? argv.filter((arg): arg is string => typeof arg === 'string') : [];
}

function getArgValue(argv: string[], flag: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) return cleanPath(argv[index + 1]);
    if (arg.startsWith(`${flag}=`)) return cleanPath(arg.slice(flag.length + 1));
  }
  return null;
}

function getComfyRootFromMainPy(argv: string[]): string | null {
  const mainPy = argv.find((arg) => /(^|[\\/])main\.py$/.test(arg));
  return mainPy ? dirnameOf(mainPy) : null;
}

export function detectComfyFoldersFromSystemStats(systemStats: unknown): ComfyDetectedFolders {
  const argv = getSystemArgv(systemStats);
  const explicitInputDir = getArgValue(argv, '--input-directory');
  const explicitOutputDir = getArgValue(argv, '--output-directory');
  const explicitBaseDir = getArgValue(argv, '--base-directory');
  const rootFromMainPy = getComfyRootFromMainPy(argv);
  const baseDir = explicitBaseDir || rootFromMainPy;
  const inputDir = explicitInputDir || joinPath(baseDir, 'input');
  const outputDir = explicitOutputDir || joinPath(baseDir, 'output');

  return {
    baseDir,
    inputDir,
    outputDir,
    input3dDir: joinPath(inputDir, '3d'),
  };
}

export function resolveComfyInput3dDirectory(options: {
  settingsInput3dDir?: string | null;
  envInput3dDir?: string | null;
  detectedInput3dDir?: string | null;
}): string | null {
  return (
    cleanPath(options.settingsInput3dDir) ||
    cleanPath(options.envInput3dDir) ||
    cleanPath(options.detectedInput3dDir)
  );
}

function cloneWorkflow(workflow: ComfyApiWorkflow): ComfyApiWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyApiWorkflow;
}

function findNode(workflow: ComfyApiWorkflow, classType: string): ComfyWorkflowNode {
  const node = Object.values(workflow).find((candidate) => candidate.class_type === classType);
  if (!node) {
    throw new Error(`ComfyUI workflow is missing ${classType}`);
  }
  return node;
}

function stringInput(inputs: Record<string, unknown>, key: string, fallback: string): string {
  const value = inputs[key];
  return typeof value === 'string' ? value : fallback;
}

function numberInput(inputs: Record<string, unknown>, key: string, fallback: number): number {
  const value = inputs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanInput(inputs: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = inputs[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function extractComfyVideoPreset(workflow: ComfyApiWorkflow): ComfyVideoPreset {
  const multiview = findNode(workflow, 'Seedance3DModelMultiView');
  const seedance = findNode(workflow, 'ByteDance2ReferenceNode');
  const saveVideo = findNode(workflow, 'SaveVideo');

  return {
    comfyUrl: DEFAULT_COMFY_URL,
    model: stringInput(seedance.inputs, 'model', 'Seedance 2.0'),
    prompt: stringInput(seedance.inputs, 'model.prompt', ''),
    videoResolution: stringInput(seedance.inputs, 'model.resolution', '720p'),
    ratio: stringInput(seedance.inputs, 'model.ratio', '9:16'),
    duration: numberInput(seedance.inputs, 'model.duration', 10),
    generateAudio: booleanInput(seedance.inputs, 'model.generate_audio', true),
    seed: numberInput(seedance.inputs, 'seed', 0),
    watermark: booleanInput(seedance.inputs, 'watermark', false),
    sceneSelection: stringInput(multiview.inputs, 'scene_selection', '场景全部对象'),
    renderResolution: numberInput(multiview.inputs, 'resolution', 1024),
    background: stringInput(multiview.inputs, 'background', '深灰影棚'),
    cameraElevation: numberInput(multiview.inputs, 'camera_elevation', 12),
    framePadding: numberInput(multiview.inputs, 'frame_padding', 1.25),
    renderEngine: stringInput(multiview.inputs, 'render_engine', 'Eevee（快速）'),
    forceRender: booleanInput(multiview.inputs, 'force_render', false),
    filenamePrefix: stringInput(saveVideo.inputs, 'filename_prefix', 'Seedance_Ads/clips/3d_model_shot'),
    format: stringInput(saveVideo.inputs, 'format', 'auto'),
    codec: stringInput(saveVideo.inputs, 'codec', 'auto'),
  };
}

export function buildComfyVideoPrompt(
  workflow: ComfyApiWorkflow,
  options: {
    modelFileName: string;
    preset: ComfyVideoPreset;
  },
): ComfyApiWorkflow {
  const prompt = cloneWorkflow(workflow);
  const loader = findNode(prompt, 'Seedance3DModelLoader');
  const multiview = findNode(prompt, 'Seedance3DModelMultiView');
  const seedance = findNode(prompt, 'ByteDance2ReferenceNode');
  const saveVideo = findNode(prompt, 'SaveVideo');
  const preset = options.preset;

  loader.inputs.model = options.modelFileName;
  multiview.inputs.scene_selection = preset.sceneSelection;
  multiview.inputs.resolution = preset.renderResolution;
  multiview.inputs.background = preset.background;
  multiview.inputs.camera_elevation = preset.cameraElevation;
  multiview.inputs.frame_padding = preset.framePadding;
  multiview.inputs.render_engine = preset.renderEngine;
  multiview.inputs.force_render = preset.forceRender;

  seedance.inputs.model = preset.model;
  seedance.inputs['model.prompt'] = preset.prompt;
  seedance.inputs['model.resolution'] = preset.videoResolution;
  seedance.inputs['model.ratio'] = preset.ratio;
  seedance.inputs['model.duration'] = preset.duration;
  seedance.inputs['model.generate_audio'] = preset.generateAudio;
  seedance.inputs.seed = preset.seed;
  seedance.inputs.watermark = preset.watermark;

  saveVideo.inputs.filename_prefix = preset.filenamePrefix;
  saveVideo.inputs.format = preset.format;
  saveVideo.inputs.codec = preset.codec;

  return prompt;
}

export function mergeComfyVideoSettings(
  preset: ComfyVideoPreset,
  settings: ComfyVideoRunSettings,
): ComfyVideoPreset {
  return {
    ...preset,
    ...settings,
    comfyUrl: settings.comfyUrl || preset.comfyUrl || DEFAULT_COMFY_URL,
  };
}

function isComfyOutputFile(value: unknown): value is ComfyOutputFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.filename === 'string';
}

export function findComfyVideoOutput(history: unknown, promptId: string): ComfyOutputFile | null {
  if (!history || typeof history !== 'object') return null;
  const promptHistory = (history as Record<string, unknown>)[promptId];
  if (!promptHistory || typeof promptHistory !== 'object') return null;
  const outputs = (promptHistory as Record<string, unknown>).outputs;
  if (!outputs || typeof outputs !== 'object') return null;

  for (const output of Object.values(outputs as Record<string, unknown>)) {
    if (!output || typeof output !== 'object') continue;
    const record = output as Record<string, unknown>;
    const videos = record.videos;
    if (Array.isArray(videos)) {
      const video = videos.find((file) => isComfyOutputFile(file));
      if (video && isComfyOutputFile(video)) return video;
    }
    for (const key of ['gifs', 'images']) {
      const files = record[key];
      if (!Array.isArray(files)) continue;
      const video = files.find((file) => isComfyOutputFile(file) && /\.(mp4|webm|mov|gif)$/i.test(file.filename));
      if (video && isComfyOutputFile(video)) return video;
    }
  }

  return null;
}
