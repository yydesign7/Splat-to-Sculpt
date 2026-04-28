/**
 * Python dependency readiness check for API routes.
 *
 * The dev server starts before `install-deps-async.sh` finishes installing
 * Python packages (open3d, trimesh, pyrender, etc.). API routes that call
 * Python scripts must verify the required packages are importable before
 * launching the subprocess, otherwise the script will crash with an
 * unhelpful "Command failed" error.
 *
 * Usage:
 *   const error = await checkPythonDeps(['open3d', 'numpy']);
 *   if (error) return NextResponse.json({ error }, { status: 503 });
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

/** Marker file written by install-deps-async.sh when all deps are installed */
const DEPS_READY_MARKER = '/tmp/deps-ready';

/** Cache the result so we don't re-check on every request after deps are confirmed ready */
let cachedReady = false;

/**
 * Checks whether the required Python packages can be imported.
 *
 * 1. If the marker file `/tmp/deps-ready` exists AND `cachedReady` is true,
 *    return immediately (fast path).
 * 2. Otherwise, run `python3 -c "import pkg1, pkg2, ..."` to verify.
 * 3. On success, set `cachedReady = true` so subsequent calls skip the subprocess.
 *
 * @param packages - List of Python package names to verify (e.g. ['open3d', 'numpy'])
 * @returns `null` if all packages are available, or an error message string
 */
export async function checkPythonDeps(packages: string[]): Promise<string | null> {
  // Fast path: if we've already confirmed deps are ready, skip check
  if (cachedReady) {
    // Still verify marker file exists (could have been cleaned up)
    try {
      await access(DEPS_READY_MARKER);
      return null;
    } catch {
      cachedReady = false;
    }
  }

  const importLine = packages.join(', ');

  try {
    await execFileAsync('python3', ['-c', `import ${importLine}`], {
      timeout: 15_000,
    });
    cachedReady = true;
    return null;
  } catch {
    return `Python dependencies (${packages.join(', ')}) are still installing. Please wait for the background installation to finish (usually 1-2 minutes).`;
  }
}

/**
 * Checks whether a system command is available on PATH.
 *
 * @param command - The command name (e.g. 'ffmpeg', 'colmap', 'blender')
 * @returns `null` if available, or an error message string
 */
export async function checkSystemCommand(command: string): Promise<string | null> {
  try {
    await execFileAsync('which', [command], { timeout: 5_000 });
    return null;
  } catch {
    return `System command "${command}" is not installed yet. Please wait for the background installation to finish.`;
  }
}

const MACOS_BLENDER_PATH = '/Applications/Blender.app/Contents/MacOS/Blender';

/**
 * Resolves the Blender executable. On macOS, launching Blender through a
 * symlink can prevent it from finding its bundled Python, so prefer the real
 * app executable when it exists.
 */
export async function resolveBlenderCommand(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      await access(MACOS_BLENDER_PATH);
      return MACOS_BLENDER_PATH;
    } catch {
      // Fall back to PATH below.
    }
  }

  try {
    const { stdout } = await execFileAsync('which', ['blender'], { timeout: 5_000 });
    return stdout.trim() || 'blender';
  } catch {
    return null;
  }
}

export async function checkBlenderCommand(): Promise<string | null> {
  const blenderCommand = await resolveBlenderCommand();
  if (blenderCommand) {
    return null;
  }

  return 'System command "blender" is not installed yet. Please wait for the background installation to finish.';
}
