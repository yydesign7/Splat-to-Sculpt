import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, mkdtemp, rm, writeFile, access } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { checkBlenderCommand, resolveBlenderCommand } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  getEphemeralSessionFromRequest,
  getSessionRoot,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';

const execFileAsync = promisify(execFile);

/** Principled BSDF material parameters */
interface MaterialParams {
  base_color?: [number, number, number];  // 0-1 RGB
  metallic?: number;                       // 0-1
  roughness?: number;                      // 0-1
  emissive_color?: [number, number, number]; // 0-1 RGB
  emissive_strength?: number;              // 0-10
  alpha?: number;                          // 0-1
  normal_scale?: number;                   // 0-5
  base_color_modified?: boolean;           // per-layer: only then Blender replaces base color
}

/** Light parameters for Blender rendering */
interface LightParams {
  ambientIntensity?: number;              // 0-3
  mainLightIntensity?: number;            // 0-10
  mainLightColor?: [number, number, number]; // 0-1 RGB
  mainLightAzimuth?: number;              // 0-360°
  mainLightElevation?: number;            // 0-90°
  fillLightIntensity?: number;            // 0-5
  fillLightAzimuth?: number;              // 0-360°
  fillLightElevation?: number;            // 0-90°
  exposure?: number;                      // 0.1-3
}

/**
 * POST /api/blender-material
 *
 * Actions:
 * 1. "list-groups" — Parse OBJ groups via Blender, return group list
 * 2. "apply" — Apply material parameters + optional texture to a specific group, export model, optionally render
 *
 * Body:
 * {
 *   action: "list-groups" | "apply",
 *   modelUrl: string,              // public URL path to model file
 *   textureUrl?: string,          // public URL path to texture image
 *   group?: string,               // group name (default "all")
 *   materialParams?: MaterialParams,  // single-group: Principled BSDF parameters
 *   layerParams?: Record<string, MaterialParams>,  // all layers: mesh object name -> params (one Blender run)
 *   render?: boolean,             // whether to render a preview image
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const sessionId = getEphemeralSessionFromRequest(request);
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing X-Ephemeral-Session-Id header' }, { status: 400 });
    }

    const body = await request.json();
    const { action, modelUrl, textureUrl, group, materialParams, layerParams, lightParams, baseColorModified, render } = body as {
      action?: string;
      modelUrl?: string;
      textureUrl?: string;
      group?: string;
      materialParams?: MaterialParams;
      layerParams?: Record<string, MaterialParams>;
      lightParams?: LightParams;
      baseColorModified?: boolean;
      render?: boolean;
    };

    if (!modelUrl) {
      return NextResponse.json({ error: 'No model file path provided' }, { status: 400 });
    }

    // Check system dependencies before processing
    const depsError = await checkBlenderCommand();
    if (depsError) {
      return NextResponse.json({ error: depsError }, { status: 503 });
    }
    const blenderCommand = await resolveBlenderCommand();

    if (!blenderCommand) {
      return NextResponse.json({ error: 'Blender executable not found' }, { status: 503 });
    }

    let objServerPath: string;
    try {
      objServerPath = resolveClientMediaUrlToFilesystem(modelUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid model path' }, { status: 400 });
    }

    let textureServerPath: string | null = null;
    if (textureUrl) {
      try {
        textureServerPath = resolveClientMediaUrlToFilesystem(textureUrl);
      } catch {
        return NextResponse.json({ error: 'Invalid texture path' }, { status: 400 });
      }
    }

    try {
      await access(objServerPath);
    } catch {
      return NextResponse.json(
        { error: `Model file not found: ${modelUrl}. If recently uploaded, please wait for upload to complete.` },
        { status: 400 }
      );
    }

    if (textureServerPath) {
      try {
        await access(textureServerPath);
      } catch {
        return NextResponse.json(
          { error: `Texture file not found: ${textureUrl}` },
          { status: 400 }
        );
      }
    }

    const blenderScript = path.join(process.cwd(), 'scripts', 'blender_material.py');

    // list-groups only needs stdout JSON — use OS temp dir and remove it (no public/blender-output spam)
    if (action === 'list-groups') {
      const listGroupsDir = await mkdtemp(path.join(tmpdir(), 'blender-list-groups-'));
      try {
        const { stdout } = await execFileAsync(blenderCommand, [
          '--background',
          '--python', blenderScript,
          '--',
          '--obj', objServerPath,
          '--output-dir', listGroupsDir,
          '--list-groups',
        ], {
          timeout: 120000,
          env: { ...process.env },
        });

        const lines = stdout.trim().split('\n');
        let result: { status?: string; groups?: string[]; error?: string } | null = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{')) {
            try {
              result = JSON.parse(line);
              break;
            } catch {
              continue;
            }
          }
        }

        if (!result) {
          return NextResponse.json({ error: 'Failed to parse Blender output', rawOutput: lines.slice(-5) }, { status: 500 });
        }

        if (result.status === 'error') {
          return NextResponse.json({ error: result.error || 'Blender processing failed' }, { status: 500 });
        }

        return NextResponse.json({
          success: true,
          groups: result.groups || [],
        });
      } finally {
        await rm(listGroupsDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (action === 'apply') {
      const jobId = randomUUID();
      const outputDir = path.join(getSessionRoot(sessionId), 'blender-output', jobId);
      await mkdir(outputDir, { recursive: true });

      const targetGroup = group || 'all';
      const useLayerParams = layerParams && Object.keys(layerParams).length > 0;
      const layerParamsPath = path.join(outputDir, 'layer_params.json');

      const blenderArgs = [
        '--background',
        '--python', blenderScript,
        '--',
        '--obj', objServerPath,
        '--output-dir', outputDir,
      ];

      if (useLayerParams) {
        await writeFile(layerParamsPath, JSON.stringify(layerParams), 'utf8');
        blenderArgs.push('--layer-params', layerParamsPath);
      } else {
        blenderArgs.push('--group', targetGroup);
        if (materialParams && Object.keys(materialParams).length > 0) {
          blenderArgs.push('--material-params', JSON.stringify(materialParams));
        }
        if (baseColorModified) {
          blenderArgs.push('--base-color-modified');
        }
      }

      if (textureServerPath) {
        blenderArgs.push('--texture', textureServerPath);
      }

      // Pass light params as JSON string
      if (lightParams && Object.keys(lightParams).length > 0) {
        blenderArgs.push('--light-params', JSON.stringify(lightParams));
      }

      // Request render if specified
      if (render) {
        blenderArgs.push('--render');
      }

      const { stdout, stderr } = await execFileAsync(blenderCommand, blenderArgs, {
        timeout: 300000, // 5 min
        env: { ...process.env },
      });

      // Parse JSON from Blender output
      const lines = stdout.trim().split('\n');
      let result: Record<string, unknown> | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
          try {
            result = JSON.parse(line);
            break;
          } catch {
            continue;
          }
        }
      }

      if (!result) {
        console.error('[blender-material] Failed to parse output. Last lines:', lines.slice(-5));
        console.error('[blender-material] stderr:', stderr?.slice(-500));
        return NextResponse.json({ error: 'Failed to parse Blender output' }, { status: 500 });
      }

      if (result.status === 'error') {
        return NextResponse.json({ error: result.error || 'Blender material application failed' }, { status: 500 });
      }

      const modelUrlOut = result.obj_path
        ? buildEphemeralFileUrl(sessionId, `blender-output/${jobId}/${path.basename(result.obj_path as string)}`)
        : null;

      const glbUrl = result.glb_path
        ? buildEphemeralFileUrl(sessionId, `blender-output/${jobId}/${path.basename(result.glb_path as string)}`)
        : null;

      const glbError = result.glb_error != null ? String(result.glb_error) : null;

      const renderUrl = result.render_path
        ? buildEphemeralFileUrl(sessionId, `blender-output/${jobId}/${path.basename(result.render_path as string)}`)
        : null;

      return NextResponse.json({
        success: true,
        modelUrl: modelUrlOut,
        glbUrl,
        glbError,
        renderUrl,
        groups: result.groups || [],
        appliedGroup: result.applied_group,
        appliedGroups: (result.applied_groups as string[] | undefined) ?? null,
      });
    }

    return NextResponse.json({ error: 'Unknown action, supported: list-groups and apply' }, { status: 400 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Blender processing failed';
    const stderr = (error as { stderr?: string })?.stderr || '';
    console.error('[blender-material] Error:', message, stderr ? `\nstderr: ${stderr.slice(-500)}` : '');
    // Extract a user-friendly error from Blender stdout if available
    const stdout = (error as { stdout?: string })?.stdout || '';
    const lines = stdout.trim().split('\n');
    let blenderError = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) blenderError = parsed.error;
        } catch { /* ignore */ }
        break;
      }
    }
    return NextResponse.json({ error: blenderError || message }, { status: 500 });
  }
}
