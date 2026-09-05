'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_COMFY_VIDEO_PRESET } from '@/lib/comfyui-video-preset';
import { classifyComfyService, readComfyProbe, type ComfyProbeResult, type ComfyServiceStatus } from '@/lib/comfyui-service-state';

interface SeedancePackStatusResult {
  success?: boolean;
  ready?: boolean;
  installed?: boolean;
  loaded?: boolean;
  customNodesDir?: string | null;
  workflowsDir?: string | null;
  missingCustomNodeFolders?: string[];
  missingWorkflowFiles?: string[];
  missingNodeTypes?: string[];
  error?: string;
}

interface Snapshot {
  address: string;
  status: ComfyServiceStatus;
  probe: ComfyProbeResult | null;
  detail: string | null;
  seedance: SeedancePackStatusResult | null;
}

interface Options { comfyUrl: string; explicitAddress: boolean }

interface ServiceResult {
  service: Snapshot;
  refresh: () => Promise<void>;
  installSeedancePack: () => Promise<void>;
  seedancePackStatus: SeedancePackStatusResult | null;
  seedanceInstalling: boolean;
  seedanceMessage: string | null;
}

export function useComfyServiceStatus({ comfyUrl, explicitAddress }: Options): ServiceResult {
  const address = comfyUrl.trim() || DEFAULT_COMFY_VIDEO_PRESET.comfyUrl;
  const [snapshot, setSnapshot] = useState<Snapshot>({ address, status: 'checking', probe: null, detail: null, seedance: null });
  const [installation, setInstallation] = useState({ address, busy: false, message: null as string | null });
  const connectedAddresses = useRef(new Set<string>());
  const request = useRef<AbortController | null>(null);
  const installRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = (): boolean => request.current === controller && !controller.signal.aborted;
    const params = new URLSearchParams({ comfyUrl: address });
    setSnapshot({ address, status: 'checking', probe: null, detail: null, seedance: null });
    try {
      const response = await fetch(`/api/comfy-video-status?${params}`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]),
      });
      const probe = readComfyProbe(await response.json());
      if (!current()) return;
      if (probe.online) connectedAddresses.current.add(address);
      const status = classifyComfyService(probe.kind, { explicitAddress, connectedBefore: connectedAddresses.current.has(address) });
      setSnapshot({ address, status, probe, detail: probe.detail, seedance: null });
      if (!probe.online) return;
      try {
        const seedanceResponse = await fetch(`/api/comfy-seedance-status?${params}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]),
        });
        const seedance = await seedanceResponse.json() as SeedancePackStatusResult;
        if (seedance.success !== true) throw new Error(seedance.error || 'Seedance check failed');
        if (current()) setSnapshot({ address, status, probe, detail: probe.detail, seedance });
      } catch (error: unknown) {
        if (current()) setSnapshot({ address, status, probe, detail: probe.detail,
          seedance: { success: false, error: error instanceof Error ? error.message : 'Seedance check failed' } });
      }
    } catch (error: unknown) {
      if (current()) setSnapshot({ address, status: 'check-failed', probe: null,
        detail: error instanceof Error ? error.message : 'Status check failed', seedance: null });
    }
  }, [address, explicitAddress]);

  useLayoutEffect(() => {
    // Cleanup invalidates the previous address immediately, before the debounce expires.
    const timer = setTimeout(() => { void refresh(); }, 400);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      installRequest.current?.abort();
    };
  }, [refresh]);

  const installSeedancePack = useCallback(async (): Promise<void> => {
    installRequest.current?.abort();
    const controller = new AbortController();
    installRequest.current = controller;
    controller.signal.addEventListener('abort', () => {
      if (installRequest.current === controller) {
        setInstallation((current) => ({ ...current, busy: false }));
      }
    }, { once: true });
    setInstallation({ address, busy: true, message: null });
    try {
      const response = await fetch('/api/install-comfy-seedance-pack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comfyUrl: address }), signal: controller.signal,
      });
      const result = await response.json() as { success?: boolean; error?: string; restartRequired?: boolean };
      if (controller.signal.aborted) return;
      if (!result.success) throw new Error(result.error || 'Seedance pack install failed');
      setInstallation({ address, busy: false, message: result.restartRequired
        ? 'Installed. Restart ComfyUI, then Check again.' : 'Seedance pack already installed.' });
      await refresh();
    } catch (error: unknown) {
      if (!controller.signal.aborted) setInstallation({ address, busy: false,
        message: error instanceof Error ? error.message : 'Seedance pack install failed' });
    }
  }, [address, refresh]);

  const service: Snapshot = snapshot.address === address ? snapshot
    : { address, status: 'checking', probe: null, detail: null, seedance: null };
  return {
    service, refresh, installSeedancePack,
    seedancePackStatus: service.seedance,
    seedanceInstalling: installation.address === address && installation.busy,
    seedanceMessage: (installation.address === address ? installation.message : null) || service.seedance?.error || null,
  };
}
