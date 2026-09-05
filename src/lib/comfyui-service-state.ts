export type ComfyServiceStatus = 'checking' | 'unconfigured' | 'disconnected' | 'connected' | 'invalid-url' | 'check-failed';
export type ComfyProbeKind = 'connected' | 'unreachable' | 'invalid-url' | 'probe-failed';

export interface ComfyProbeResult {
  kind: ComfyProbeKind;
  online: boolean;
  detail: string | null;
  version: string | null;
  detectedInputDir: string | null;
  detectedOutputDir: string | null;
  detectedInput3dDir: string | null;
}

export const COMFY_SERVICE_LABELS: Record<ComfyServiceStatus, string> = {
  checking: '检查中', unconfigured: '未配置', disconnected: '未连接',
  connected: '已连接', 'invalid-url': '地址无效', 'check-failed': '检查失败',
};

export const COMFY_SERVICE_HINTS: Record<ComfyServiceStatus, string> = {
  checking: '正在检查 ComfyUI 连接…',
  unconfigured: '尚未检测到可用服务，请启动 ComfyUI 或设置地址。',
  disconnected: '请检查地址并启动 ComfyUI，然后检查连接。',
  connected: 'ComfyUI 已连接。',
  'invalid-url': '请填写有效的本机 HTTP(S) 地址。',
  'check-failed': '连接检查暂时失败，请重试或查看详情。',
};

export function classifyComfyService(
  kind: ComfyProbeKind,
  context: { explicitAddress: boolean; connectedBefore: boolean },
): Exclude<ComfyServiceStatus, 'checking'> {
  if (kind === 'unreachable') return context.explicitAddress || context.connectedBefore ? 'disconnected' : 'unconfigured';
  return kind === 'probe-failed' ? 'check-failed' : kind;
}

export function readComfyProbe(value: unknown): ComfyProbeResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid ComfyUI status response');
  const data = value as Record<string, unknown>;
  const kind = data.kind;
  if ((kind !== 'connected' && kind !== 'unreachable' && kind !== 'invalid-url' && kind !== 'probe-failed')
    || data.online !== (kind === 'connected')) throw new Error('Invalid ComfyUI status response');
  const string = (key: string): string | null => typeof data[key] === 'string' ? data[key] : null;
  return {
    kind, online: kind === 'connected', detail: string('detail'), version: string('version'),
    detectedInputDir: string('detectedInputDir'), detectedOutputDir: string('detectedOutputDir'),
    detectedInput3dDir: string('detectedInput3dDir'),
  };
}
