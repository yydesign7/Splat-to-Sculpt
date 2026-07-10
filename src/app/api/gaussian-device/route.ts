import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

type DeviceType = 'cuda' | 'mps' | 'cpu';
type TrainingSupport = {
  trueTrainingAvailable: boolean;
  trueTrainingUnavailableReason?: string;
};

function resolveTrainerCommand(envName: string, fallback: string): string {
  return process.env[envName] || fallback;
}

function resolvePythonCommand(nsTrainCommand: string): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (nsTrainCommand.includes('/') || nsTrainCommand.includes('\\')) {
    return path.join(path.dirname(nsTrainCommand), 'python3');
  }
  return 'python3';
}

async function detectDevice(pythonCommand: string): Promise<{ deviceType: DeviceType; label: string }> {
  try {
    await execFileAsync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
    return { deviceType: 'cuda', label: 'CUDA GPU detected' };
  } catch {
    // Continue with Apple MPS detection.
  }

  try {
    const { stdout } = await execFileAsync(
      pythonCommand,
      [
        '-c',
        [
          'import torch',
          'ok = False',
          'try:',
          '    ok = bool(torch.backends.mps.is_available())',
          '    _ = torch.ones(1, device="mps") if ok else None',
          'except Exception:',
          '    ok = False',
          'print("mps" if ok else "cpu")',
        ].join('\n'),
      ],
      {
        timeout: 8000,
        env: {
          ...process.env,
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
        },
      },
    );
    if (stdout.trim() === 'mps') {
      return { deviceType: 'mps', label: 'Apple MPS detected' };
    }
  } catch {
    // Torch may be unavailable in lightweight environments.
  }

  return { deviceType: 'cpu', label: 'CPU fallback' };
}

async function detectTrueTrainingSupport(pythonCommand: string, deviceType: DeviceType): Promise<TrainingSupport> {
  if (deviceType !== 'cuda') {
    return {
      trueTrainingAvailable: false,
      trueTrainingUnavailableReason: 'Nerfstudio Splatfacto requires the gsplat CUDA rasterizer in this setup.',
    };
  }

  try {
    const { stdout } = await execFileAsync(
      pythonCommand,
      [
        '-c',
        [
          'ok = False',
          'try:',
          '    from gsplat.cuda import _wrapper',
          '    ok = getattr(_wrapper, "_C", None) is not None',
          'except Exception:',
          '    ok = False',
          'print("ok" if ok else "missing")',
        ].join('\n'),
      ],
      {
        timeout: 8000,
        env: {
          ...process.env,
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/private/tmp/studio3dgs-matplotlib',
          XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || '/private/tmp/studio3dgs-cache',
        },
      },
    );
    if (stdout.trim() === 'ok') {
      return { trueTrainingAvailable: true };
    }
  } catch {
    // Fall through to a clear unavailable response.
  }

  return {
    trueTrainingAvailable: false,
    trueTrainingUnavailableReason: 'The gsplat CUDA extension is not available in the current Python environment.',
  };
}

export async function GET() {
  const nsTrainCommand = resolveTrainerCommand('NS_TRAIN_BIN', 'ns-train');
  const pythonCommand = resolvePythonCommand(nsTrainCommand);
  const device = await detectDevice(pythonCommand);
  const trainingSupport = await detectTrueTrainingSupport(pythonCommand, device.deviceType);
  return NextResponse.json({ ...device, ...trainingSupport });
}
