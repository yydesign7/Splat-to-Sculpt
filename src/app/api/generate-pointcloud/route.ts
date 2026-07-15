import { NextRequest, NextResponse } from 'next/server';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir, rm, readdir, copyFile, readFile, stat } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getTask, setTask } from '@/lib/pointcloud-task-store';
import { checkSystemCommand } from '@/lib/check-python-deps';
import {
  buildEphemeralFileUrl,
  getSessionRoot,
  isValidEphemeralSessionId,
  resolveClientMediaUrlToFilesystem,
} from '@/lib/ephemeral-storage';
import { killProcessTree } from '@/lib/process-tree';

const execFileAsync = promisify(execFile);

async function ensurePointCloudNotCancelled(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (task?.status === 'cancelled') {
    throw new Error('Point cloud generation was cancelled');
  }
}

function runTrackedCommand(
  taskId: string,
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    if (typeof child.pid === 'number') {
      setTask(taskId, { activePid: child.pid }).catch(() => {});
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = options.timeout
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          if (typeof child.pid === 'number') {
            killProcessTree(child.pid).catch(() => {});
          } else {
            child.kill('SIGTERM');
          }
          const err = new Error(`${command} timed out`) as Error & { stdout?: string; stderr?: string };
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        }, options.timeout)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      setTask(taskId, { activePid: undefined }).catch(() => {});
      const enriched = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      enriched.stdout = stdout;
      enriched.stderr = stderr;
      settled = true;
      reject(enriched);
    });
    child.on('close', async (code) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      await setTask(taskId, { activePid: undefined }).catch(() => {});
      settled = true;
      const latest = await getTask(taskId);
      if (latest?.status === 'cancelled') {
        reject(new Error('Point cloud generation was cancelled'));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(`${command} exited with code ${code}`) as Error & { stdout?: string; stderr?: string };
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

/** Detect whether a CUDA-capable GPU is available (for COLMAP GPU mode) */
async function hasGpu(): Promise<boolean> {
  try {
    // Check nvidia-smi first (most reliable)
    await execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
    return true;
  } catch {
    // Fallback: check /dev/nvidia* devices
    try {
      const devEntries = await readdir('/dev');
      return devEntries.some(e => e.startsWith('nvidia'));
    } catch {
      return false;
    }
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    framePaths,
    enableDepthFusion = true,
    enableSegmentation = true,
    enableForegroundMask = true,
    ephemeralSessionId,
    preserveColmapWorkspace = false,
    colmapOnly = false,
  } = body as {
    framePaths?: string[];
    enableDepthFusion?: boolean;
    enableSegmentation?: boolean;
    enableForegroundMask?: boolean;
    ephemeralSessionId?: string;
    preserveColmapWorkspace?: boolean;
    colmapOnly?: boolean;
  };

  if (!framePaths || framePaths.length === 0) {
    return NextResponse.json({ error: 'No frame image paths provided' }, { status: 400 });
  }
  if (!isValidEphemeralSessionId(ephemeralSessionId)) {
    return NextResponse.json({ error: 'Missing or invalid ephemeralSessionId' }, { status: 400 });
  }

  // Check system dependencies before starting the task
  const depsError = await checkSystemCommand('colmap');
  if (depsError) {
    return NextResponse.json({ error: depsError }, { status: 503 });
  }

  const taskId = randomUUID();
  setTask(taskId, {
    status: 'processing',
    progress: 'Initializing...',
    progressStep: 0,
    enableDepthFusion,
    enableSegmentation,
    enableForegroundMask,
    ephemeralSessionId,
  });

  // Run the heavy COLMAP + depth processing asynchronously
  runPipeline(taskId, framePaths, enableDepthFusion, enableSegmentation, enableForegroundMask, ephemeralSessionId, preserveColmapWorkspace, colmapOnly).catch(() => {});

  // Return the task ID immediately so the client can poll for progress
  return NextResponse.json({
    success: true,
    taskId,
    message: 'Point cloud generation task started',
  });
}

/**
 * Run dense matching (patch_match_stereo) with per-frame progress tracking.
 * COLMAP patch_match_stereo prints lines like:
 *   "Extracted patch match stereo image 3/120"
 * We parse these to report progress.
 */
async function runPatchMatchStereo(
  taskId: string,
  databasePath: string,
  sparseOutputDir: string,
  imagesDir: string,
  denseDir: string,
  totalImages: number,
  useGpu: boolean,
): Promise<void> {
  const gpuIndex = useGpu ? '0' : '-1';

  return new Promise<void>((resolve, reject) => {
    const args = [
      'patch_match_stereo',
      '--workspace_path', denseDir,
      '--workspace_format', 'COLMAP',
      '--PatchMatchStereo.gpu_index', gpuIndex,
      '--PatchMatchStereo.max_image_size', '1600',
      '--PatchMatchStereo.window_radius', '5',
      '--PatchMatchStereo.num_samples', '15',
      '--PatchMatchStereo.num_iterations', '8',
      '--PatchMatchStereo.geom_consistency', '1',
    ];

    const child = spawn('colmap', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    if (typeof child.pid === 'number') {
      setTask(taskId, { activePid: child.pid }).catch(() => {});
    }

    let lastReportedFrame = -1;

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      // Parse progress lines like: "Extracted patch match stereo image 3/120"
      const match = text.match(/image\s+(\d+)\/(\d+)/i);
      if (match) {
        const current = parseInt(match[1], 10);
        if (current > lastReportedFrame) {
          lastReportedFrame = current;
          setTask(taskId, {
            progress: `Dense matching frame ${current}/${totalImages}...`,
          }).catch(() => {});
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      // Also check stderr for progress
      const match = text.match(/image\s+(\d+)\/(\d+)/i);
      if (match) {
        const current = parseInt(match[1], 10);
        if (current > lastReportedFrame) {
          lastReportedFrame = current;
          setTask(taskId, {
            progress: `Dense matching frame ${current}/${totalImages}...`,
          }).catch(() => {});
        }
      }
    });

    child.on('close', async (code: number) => {
      await setTask(taskId, { activePid: undefined }).catch(() => {});
      const latest = await getTask(taskId);
      if (latest?.status === 'cancelled') {
        reject(new Error('Point cloud generation was cancelled'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`patch_match_stereo exited with code ${code}`));
      }
    });

    child.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function runPipeline(
  taskId: string,
  framePaths: string[],
  enableDepthFusion: boolean,
  enableSegmentation: boolean,
  enableForegroundMask: boolean,
  ephemeralSessionId: string,
  preserveColmapWorkspace: boolean,
  colmapOnly: boolean,
) {
  let workDir = '';
  try {
    await ensurePointCloudNotCancelled(taskId);
    const pointcloudJobId = randomUUID();
    workDir = path.join('/tmp', `pointcloud_${pointcloudJobId}`);
    const imagesDir = path.join(workDir, 'images');
    const maskedImagesDir = path.join(workDir, 'masked_images');
    const sparseDir = path.join(workDir, 'sparse');
    const denseDir = path.join(workDir, 'dense');
    const depthDir = path.join(workDir, 'depth_maps');
    const masksDir = path.join(workDir, 'masks');
    const segmentDir = path.join(workDir, 'segmented');
    const segStep = enableDepthFusion ? 10 : 8;

    await mkdir(imagesDir, { recursive: true });
    await mkdir(sparseDir, { recursive: true });
    if (enableDepthFusion) {
      await mkdir(depthDir, { recursive: true });
    }

    // Detect GPU availability upfront
    const useGpu = await hasGpu();
    console.log(`[generate-pointcloud] GPU available: ${useGpu}`);

    // Copy frame images to work directory
    const maxFrames = 120;
    const step = Math.max(1, Math.floor(framePaths.length / maxFrames));
    const selectedFrames: string[] = [];
    for (let i = 0; i < framePaths.length; i += step) {
      if (selectedFrames.length >= maxFrames) break;
      selectedFrames.push(framePaths[i]);
    }

    // ── Step 1: Prepare Frames ──────────────────────────────────────
    await setTask(taskId, { progress: `Preparing frame images (${selectedFrames.length} frames)...`, progressStep: 1 });

    for (let i = 0; i < selectedFrames.length; i++) {
      const srcPath = resolveClientMediaUrlToFilesystem(selectedFrames[i]!);
      const ext = path.extname(selectedFrames[i]!);
      const destPath = path.join(imagesDir, `frame_${String(i + 1).padStart(4, '0')}${ext}`);
      await copyFile(srcPath, destPath);
    }

    let masksGenerated = false;
    if (enableForegroundMask) {
      await setTask(taskId, { progress: 'Generating foreground masks...', progressStep: 1 });
      const maskScriptPath = path.join(process.cwd(), 'scripts', 'generate_foreground_masks.py');
      try {
        const { stdout, stderr } = await runTrackedCommand(taskId, 'python3', [
          maskScriptPath,
          '--images-dir', imagesDir,
          '--masks-dir', masksDir,
          '--masked-images-dir', maskedImagesDir,
        ], { timeout: 300000 });
        if (stdout) console.log('[foreground-mask]', stdout);
        if (stderr) console.error('[foreground-mask stderr]', stderr);
        const maskEntries = await readdir(masksDir).catch(() => [] as string[]);
        const maskedImageEntries = await readdir(maskedImagesDir).catch(() => [] as string[]);
        const maskResultLine = stdout.trim().split('\n').reverse().find((line) => line.trim().startsWith('{'));
        const maskResult = maskResultLine
          ? JSON.parse(maskResultLine) as { valid?: boolean; method?: string; maxForegroundRatio?: number }
          : null;
        const maskCount = maskEntries.filter((entry) => entry.toLowerCase().endsWith('.png')).length;
        const maskedImageCount = maskedImageEntries.filter((entry) => /\.(jpe?g|png|webp)$/i.test(entry)).length;
        masksGenerated =
          maskResult?.valid === true &&
          maskCount === selectedFrames.length &&
          maskedImageCount === selectedFrames.length;
        if (!masksGenerated) {
          console.warn('[foreground-mask] Generated masks failed quality checks; COLMAP will run without mask_path.', maskResult);
        }
      } catch (maskErr: unknown) {
        const maskErrorMsg = maskErr instanceof Error ? maskErr.message : 'Foreground mask generation failed';
        console.error('[foreground-mask] Error (non-fatal):', maskErrorMsg);
        masksGenerated = false;
      }
    }
    const denseInputImagesDir = masksGenerated ? maskedImagesDir : imagesDir;

    // ── Step 2: Feature Extraction ──────────────────────────────────
    const databasePath = path.join(workDir, 'database.db');
    await setTask(taskId, { progress: 'Extracting features...', progressStep: 2 });

    const featureExtractorArgs = [
      'feature_extractor',
      '--database_path', databasePath,
      '--image_path', imagesDir,
      '--ImageReader.camera_model', 'SIMPLE_RADIAL',
      '--SiftExtraction.use_gpu', useGpu ? '1' : '0',
      '--SiftExtraction.max_num_features', '32000',
      '--SiftExtraction.peak_threshold', '0.004',
    ];
    await runTrackedCommand(taskId, 'colmap', featureExtractorArgs, { timeout: 600000 });

    // ── Step 3: Feature Matching ────────────────────────────────────
    await setTask(taskId, { progress: 'Feature matching...', progressStep: 3 });
    const matcherArgs = colmapOnly
      ? [
          'sequential_matcher',
          '--database_path', databasePath,
          '--SiftMatching.use_gpu', useGpu ? '1' : '0',
          '--SequentialMatching.overlap', '10',
          '--SequentialMatching.loop_detection', '0',
        ]
      : [
          'exhaustive_matcher',
          '--database_path', databasePath,
          '--SiftMatching.use_gpu', useGpu ? '1' : '0',
        ];
    await runTrackedCommand(taskId, 'colmap', matcherArgs, { timeout: 600000 });

    // ── Step 4: Sparse Reconstruction ───────────────────────────────
    await setTask(taskId, { progress: 'Sparse reconstruction...', progressStep: 4 });
    const sparseOutputDir = path.join(sparseDir, '0');
    await mkdir(sparseOutputDir, { recursive: true });

    await runTrackedCommand(taskId, 'colmap', [
      'mapper',
      '--database_path', databasePath,
      '--image_path', imagesDir,
      '--output_path', sparseDir,
      '--Mapper.init_min_num_inliers', '100',
      '--Mapper.init_max_error', '4',
      '--Mapper.abs_pose_min_num_inliers', '20',
      '--Mapper.abs_pose_min_inlier_ratio', '0.25',
      '--Mapper.filter_max_reproj_error', '4',
      '--Mapper.tri_merge_max_reproj_error', '4',
    ], { timeout: 600000 });

    if (colmapOnly) {
      await fallbackToSparsePly(
        taskId,
        sparseOutputDir,
        pointcloudJobId,
        workDir,
        enableSegmentation,
        false,
        masksGenerated ? masksDir : undefined,
        ephemeralSessionId,
        preserveColmapWorkspace,
      );
      return;
    }

    // ── Step 5: Image Undistortion (dense reconstruction prerequisite) ─
    await setTask(taskId, { progress: 'Undistorting images...', progressStep: 5 });
    await mkdir(denseDir, { recursive: true });

    await runTrackedCommand(taskId, 'colmap', [
      'image_undistorter',
      '--image_path', denseInputImagesDir,
      '--input_path', sparseOutputDir,
      '--output_path', denseDir,
      '--output_type', 'COLMAP',
    ], { timeout: 300000 });

    // ── Step 6: Dense Matching (patch_match_stereo) ──────────────────
    await setTask(taskId, {
      progress: `Dense matching frame 0/${selectedFrames.length}...`,
      progressStep: 6,
    });

    try {
      await runPatchMatchStereo(
        taskId,
        databasePath,
        sparseOutputDir,
        denseInputImagesDir,
        denseDir,
        selectedFrames.length,
        useGpu,
      );
    } catch (denseMatchErr: unknown) {
      const msg = denseMatchErr instanceof Error ? denseMatchErr.message : 'Dense matching failed';
      console.error('[generate-pointcloud] Dense matching error (non-fatal):', msg);
      await setTask(taskId, { progress: 'Dense matching failed, falling back to sparse reconstruction...' });
      // Fall through to sparse-only PLY generation
      await fallbackToSparsePly(
        taskId,
        sparseOutputDir,
        pointcloudJobId,
        workDir,
        enableSegmentation,
        enableDepthFusion,
        masksGenerated ? masksDir : undefined,
        ephemeralSessionId,
        preserveColmapWorkspace,
      );
      return;
    }

    // ── Step 7: Dense Fusion (stereo_fusion) ─────────────────────────
    await setTask(taskId, { progress: 'Fusing dense point cloud...', progressStep: 7 });

    const fusedPlyPath = path.join(denseDir, 'fused.ply');
    try {
      await runTrackedCommand(taskId, 'colmap', [
        'stereo_fusion',
        '--workspace_path', denseDir,
        '--workspace_format', 'COLMAP',
        '--input_type', 'geometric',
        '--StereoFusion.check_num_images', '4',
        '--StereoFusion.max_image_size', '1600',
        '--output_path', fusedPlyPath,
      ], { timeout: 300000 });
    } catch (fusionErr: unknown) {
      const msg = fusionErr instanceof Error ? fusionErr.message : 'Stereo fusion failed';
      console.error('[generate-pointcloud] Stereo fusion error (non-fatal):', msg);
      // Fall back to sparse PLY
      await fallbackToSparsePly(
        taskId,
        sparseOutputDir,
        pointcloudJobId,
        workDir,
        enableSegmentation,
        enableDepthFusion,
        masksGenerated ? masksDir : undefined,
        ephemeralSessionId,
        preserveColmapWorkspace,
      );
      return;
    }

    // Check if fused PLY was actually generated and has content
    let densePlyExists = false;
    try {
      const fusedStat = await stat(fusedPlyPath);
      densePlyExists = fusedStat.size > 100; // at least 100 bytes
    } catch {
      densePlyExists = false;
    }

    if (!densePlyExists) {
      console.log('[generate-pointcloud] Dense PLY not generated, falling back to sparse');
      await fallbackToSparsePly(
        taskId,
        sparseOutputDir,
        pointcloudJobId,
        workDir,
        enableSegmentation,
        enableDepthFusion,
        masksGenerated ? masksDir : undefined,
        ephemeralSessionId,
        preserveColmapWorkspace,
      );
      return;
    }

    const foregroundDensePlyPath = await filterPointCloudByMasks(
      taskId,
      fusedPlyPath,
      sparseOutputDir,
      masksGenerated ? masksDir : undefined,
      workDir,
      'dense',
    );

    // ── Step 8: Depth Estimation (Depth Anything V2) — optional ──────
    if (enableDepthFusion) {
      await setTask(taskId, { progress: 'Estimating depth maps (Depth Anything V2)...', progressStep: 8 });

      const scriptPath = path.join(process.cwd(), 'scripts', 'depth_estimate.py');
      try {
        const { stdout, stderr } = await runTrackedCommand(taskId, 'python3', [
          scriptPath,
          '--images_dir', denseInputImagesDir,
          '--output_dir', depthDir,
          '--model_size', 'small',
        ], { timeout: 600000 });

        if (stdout) console.log('[depth_estimate]', stdout);
        if (stderr) console.error('[depth_estimate stderr]', stderr);
      } catch (depthErr: unknown) {
        const depthErrorMsg = depthErr instanceof Error ? depthErr.message : 'Depth estimation failed';
        console.error('[depth_estimate] Error (non-fatal):', depthErrorMsg);
        // Depth estimation failure is non-fatal — use dense point cloud as-is
      }

      // ── Step 9: Depth Alignment & Fusion — optional ────────────────
      const depthFiles = await readdir(depthDir).catch(() => [] as string[]);
      const depthNpyFiles = depthFiles.filter(f => f.endsWith('.npy'));

      if (depthNpyFiles.length > 0) {
        await setTask(taskId, { progress: 'Aligning depths and fusing point cloud...', progressStep: 9 });

        const fusionScriptPath = path.join(process.cwd(), 'scripts', 'depth_fusion.py');
        const mergedPlyPath = path.join(workDir, 'merged.ply');

        try {
          const { stdout: fusionStdout, stderr: fusionStderr } = await runTrackedCommand(taskId, 'python3', [
            fusionScriptPath,
            '--sparse_dir', sparseOutputDir,
            '--images_dir', denseInputImagesDir,
            '--depth_dir', depthDir,
            '--dense_ply', foregroundDensePlyPath,
            '--output_ply', mergedPlyPath,
            '--sample_step', '2',
          ], { timeout: 600000 });

          if (fusionStdout) console.log('[depth_fusion]', fusionStdout);
          if (fusionStderr) console.error('[depth_fusion stderr]', fusionStderr);

          // Check if merged PLY was generated
          try {
            const mergedStat = await stat(mergedPlyPath);
            if (mergedStat.size > 100) {
              const foregroundMergedPlyPath = await filterPointCloudByMasks(
                taskId,
                mergedPlyPath,
                sparseOutputDir,
                masksGenerated ? masksDir : undefined,
                workDir,
                'depth-merged',
              );
              const finalMergedPlyPath = enableSegmentation
                ? await segmentPointCloud(taskId, foregroundMergedPlyPath, segmentDir, segStep)
                : foregroundMergedPlyPath;
              await copyResultToSession(
                taskId,
                finalMergedPlyPath,
                pointcloudJobId,
                workDir,
                true,
                [],
                ephemeralSessionId,
                preserveColmapWorkspace,
              );
              return;
            }
          } catch {
            // Merged PLY not found, fall through to dense-only
          }
        } catch (fusionErr: unknown) {
          const fusionErrorMsg = fusionErr instanceof Error ? fusionErr.message : 'Depth fusion failed';
          console.error('[depth_fusion] Error (non-fatal):', fusionErrorMsg);
        }
      }
    }

    // ── Step 10/8: Segmentation — optional ──────────────────────────────
    let finalPlyPath = foregroundDensePlyPath;
    const layerFiles: string[] = [];

    if (enableSegmentation) {
      finalPlyPath = await segmentPointCloud(taskId, foregroundDensePlyPath, segmentDir, segStep);
    }

    // ── Final step: Copy final PLY as output ────────────────────────────
    const finalStep = enableDepthFusion ? (enableSegmentation ? 11 : 10) : (enableSegmentation ? 9 : 8);
    await setTask(taskId, { progress: 'Generating point cloud file...', progressStep: finalStep });
    await copyResultToSession(
      taskId,
      finalPlyPath,
      pointcloudJobId,
      workDir,
      false,
      layerFiles,
      ephemeralSessionId,
      preserveColmapWorkspace,
    );

  } catch (error: unknown) {
    const currentTask = await getTask(taskId);
    if (currentTask?.status === 'cancelled') {
      if (workDir && !preserveColmapWorkspace) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
      return;
    }
    if (workDir && !preserveColmapWorkspace) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : 'Point cloud generation failed';
    console.error('[generate-pointcloud] Error:', message);
    await setTask(taskId, { status: 'error', error: message });
  }
}

async function ensureColmapTextModel(
  taskId: string,
  sparseOutputDir: string,
  workDir: string,
): Promise<string> {
  const textModelDir = path.join(workDir, 'sparse_text');
  const camerasTextPath = path.join(textModelDir, 'cameras.txt');
  const imagesTextPath = path.join(textModelDir, 'images.txt');
  try {
    await Promise.all([stat(camerasTextPath), stat(imagesTextPath)]);
    return textModelDir;
  } catch {
    await mkdir(textModelDir, { recursive: true });
  }

  await runTrackedCommand(taskId, 'colmap', [
    'model_converter',
    '--input_path', sparseOutputDir,
    '--output_path', textModelDir,
    '--output_type', 'TXT',
  ], { timeout: 30000 });
  return textModelDir;
}

async function filterPointCloudByMasks(
  taskId: string,
  inputPlyPath: string,
  sparseOutputDir: string,
  masksDir: string | undefined,
  workDir: string,
  outputName: string,
): Promise<string> {
  if (!masksDir) return inputPlyPath;

  await setTask(taskId, { progress: 'Filtering point cloud with foreground masks...' });
  const filterDir = path.join(workDir, 'foreground-filtered');
  const outputPlyPath = path.join(filterDir, `${outputName}.ply`);
  try {
    await mkdir(filterDir, { recursive: true });
    const textModelDir = await ensureColmapTextModel(taskId, sparseOutputDir, workDir);
    const filterScriptPath = path.join(process.cwd(), 'scripts', 'filter_pointcloud_by_masks.py');
    const { stdout, stderr } = await runTrackedCommand(taskId, 'python3', [
      filterScriptPath,
      '--input-ply', inputPlyPath,
      '--output-ply', outputPlyPath,
      '--sparse-dir', textModelDir,
      '--masks-dir', masksDir,
      '--min-visible-views', '3',
      '--min-foreground-ratio', '0.6',
      '--max-views', '24',
    ], { timeout: 300000 });
    if (stderr.trim()) console.error('[foreground-point-filter stderr]', stderr.slice(-4000));
    const resultLine = stdout.trim().split('\n').reverse().find((line) => line.trim().startsWith('{'));
    const result = resultLine
      ? JSON.parse(resultLine) as { status?: string; inputPointCount?: number; retainedPointCount?: number; retainedRatio?: number }
      : null;
    const outputStat = await stat(outputPlyPath);
    if (result?.status === 'ok' && outputStat.size > 100) {
      console.log('[foreground-point-filter]', result);
      return outputPlyPath;
    }
  } catch (filterErr: unknown) {
    const message = filterErr instanceof Error ? filterErr.message : 'Foreground point filtering failed';
    const stderr = filterErr instanceof Error && 'stderr' in filterErr
      ? String((filterErr as Error & { stderr?: string }).stderr || '')
      : '';
    console.error('[foreground-point-filter] Error (non-fatal):', message, stderr.slice(-4000));
  }
  return inputPlyPath;
}

async function segmentPointCloud(
  taskId: string,
  inputPlyPath: string,
  segmentDir: string,
  progressStep: number,
): Promise<string> {
  await setTask(taskId, { progress: 'Segmenting point cloud...', progressStep });

  const segmentScriptPath = path.join(process.cwd(), 'scripts', 'pointcloud_segment.py');
  const segmentedPlyPath = path.join(segmentDir, 'output.ply');
  const layersDir = path.join(segmentDir, 'layers');

  try {
    await mkdir(segmentDir, { recursive: true });

    const { stdout: segStdout, stderr: segStderr } = await runTrackedCommand(taskId, 'python3', [
      segmentScriptPath,
      '--input', inputPlyPath,
      '--output_ply', segmentedPlyPath,
      '--layers_dir', layersDir,
      '--mode', 'segment_all',
    ], { timeout: 300000 });

    if (segStdout) console.log('[segmentation]', segStdout);
    if (segStderr) console.error('[segmentation stderr]', segStderr);

    try {
      const segStat = await stat(segmentedPlyPath);
      if (segStat.size > 100) {
        return segmentedPlyPath;
      }
    } catch {
      // Segmented PLY not found, use the original PLY as-is.
    }
  } catch (segErr: unknown) {
    const segErrorMsg = segErr instanceof Error ? segErr.message : 'Segmentation failed';
    console.error('[segmentation] Error (non-fatal):', segErrorMsg);
  }

  return inputPlyPath;
}

/** Copy sparse COLMAP model to PLY and publish as result */
async function fallbackToSparsePly(
  taskId: string,
  sparseOutputDir: string,
  pointcloudJobId: string,
  workDir: string,
  enableSegmentation: boolean,
  enableDepthFusion: boolean,
  masksDir: string | undefined,
  ephemeralSessionId: string,
  preserveColmapWorkspace: boolean,
): Promise<void> {
  const plyOutputPath = path.join(sparseOutputDir, 'points3D.ply');

  try {
    await runTrackedCommand(taskId, 'colmap', [
      'model_converter',
      '--input_path', sparseOutputDir,
      '--output_path', plyOutputPath,
      '--output_type', 'PLY',
    ], { timeout: 30000 });
  } catch {
    // Conversion may fail if model format is unexpected
  }

  // Find PLY file
  let plySrcPath = '';
  try {
    await readFile(plyOutputPath);
    plySrcPath = plyOutputPath;
  } catch {
    // Search for any .ply file recursively
    const findPly = async (dir: string): Promise<string | null> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = await findPly(fullPath);
          if (result) return result;
        } else if (entry.name.endsWith('.ply')) {
          return fullPath;
        }
      }
      return null;
    };
    plySrcPath = (await findPly(workDir)) || '';
  }

  if (!plySrcPath) {
    await setTask(taskId, { status: 'error', error: 'COLMAP failed to generate point cloud file' });
    if (!preserveColmapWorkspace) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  const segmentDir = path.join(workDir, 'segmented');
  const segStep = enableDepthFusion ? 10 : 8;
  const foregroundPlyPath = await filterPointCloudByMasks(
    taskId,
    plySrcPath,
    sparseOutputDir,
    masksDir,
    workDir,
    'sparse',
  );
  const finalPlyPath = enableSegmentation
    ? await segmentPointCloud(taskId, foregroundPlyPath, segmentDir, segStep)
    : foregroundPlyPath;

  await copyResultToSession(
    taskId,
    finalPlyPath,
    pointcloudJobId,
    workDir,
    false,
    [],
    ephemeralSessionId,
    preserveColmapWorkspace,
  );
}

/** Copy final PLY into the browser ephemeral session dir and expose API URLs */
async function copyResultToSession(
  taskId: string,
  plySrcPath: string,
  pointcloudJobId: string,
  workDir: string,
  withDepthFusion: boolean,
  layerFiles: string[],
  ephemeralSessionId: string,
  preserveColmapWorkspace: boolean,
): Promise<void> {
  const sessionRoot = getSessionRoot(ephemeralSessionId);
  const destPlyDir = path.join(sessionRoot, 'pointclouds', pointcloudJobId);
  await mkdir(destPlyDir, { recursive: true });
  const plyDestPath = path.join(destPlyDir, 'output.ply');
  await copyFile(plySrcPath, plyDestPath);

  const layersSrcDir = path.join(workDir, 'segmented', 'layers');
  const layersDestDir = path.join(destPlyDir, 'layers');
  let layerNames: string[] = [];
  try {
    const layerEntries = await readdir(layersSrcDir);
    const plyFiles = layerEntries.filter(f => f.endsWith('.ply'));
    if (plyFiles.length > 0) {
      await mkdir(layersDestDir, { recursive: true });
      for (const f of plyFiles) {
        await copyFile(path.join(layersSrcDir, f), path.join(layersDestDir, f));
      }
      const metaFile = layerEntries.find(f => f === 'layers_meta.json');
      if (metaFile) {
        await copyFile(path.join(layersSrcDir, metaFile), path.join(layersDestDir, metaFile));
      }
      layerFiles = plyFiles.map((f) =>
        buildEphemeralFileUrl(ephemeralSessionId, `pointclouds/${pointcloudJobId}/layers/${f}`),
      );

      if (metaFile) {
        try {
          const metaRaw = await readFile(path.join(layersSrcDir, metaFile), 'utf-8');
          const meta = JSON.parse(metaRaw);
          if (meta.layers && Array.isArray(meta.layers)) {
            layerNames = meta.layers.map((l: { name?: string }) => l.name || 'unknown');
          }
        } catch {
          // Ignore metadata parse errors
        }
      }
    }
  } catch {
    // No layers to copy
  }

  let pointCount = 0;
  try {
    const plyContent = await readFile(plyDestPath, 'utf-8');
    const vertexMatch = plyContent.match(/element vertex (\d+)/);
    if (vertexMatch) {
      pointCount = parseInt(vertexMatch[1], 10);
    }
  } catch {
    // Ignore parse errors
  }

  if (!preserveColmapWorkspace) {
    await rm(workDir, { recursive: true, force: true });
  }

  await setTask(taskId, {
    status: 'done',
    progress: withDepthFusion ? 'Done (dense + depth fusion)' : 'Done (dense reconstruction)',
    result: {
      plyUrl: buildEphemeralFileUrl(ephemeralSessionId, `pointclouds/${pointcloudJobId}/output.ply`),
      pointCount,
      layerFiles,
      layerNames,
      ...(preserveColmapWorkspace
        ? {
            colmapWorkspacePath: workDir,
            colmapImagesDir: path.join(workDir, 'images'),
            colmapSparseDir: path.join(workDir, 'sparse', '0'),
            colmapDatabasePath: path.join(workDir, 'database.db'),
            colmapMasksDir: path.join(workDir, 'masks'),
          }
        : {}),
    },
  });
}
