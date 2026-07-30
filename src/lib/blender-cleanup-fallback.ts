export type BlenderScriptResult = {
  status?: string;
  error?: string;
};

export type BlenderFailureDetails = {
  message?: string;
  code?: number | string | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  parsedScriptResult?: BlenderScriptResult | null;
};

export type CleanupPassthroughResult = {
  status: 'ok';
  glb_path: string;
  obj_path: null;
  vertex_count_before: null;
  vertex_count_after: null;
  face_count_before: null;
  face_count_after: null;
  cleanup_passthrough: true;
};

export function shouldPassthroughOnBlenderFailure(details: BlenderFailureDetails): boolean {
  if (details.parsedScriptResult) {
    return false;
  }

  const text = [details.message, details.stdout, details.stderr, details.signal]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  const code = details.code == null ? null : String(details.code);

  return (
    code === '139' ||
    details.signal === 'SIGSEGV' ||
    text.includes('segmentation fault') ||
    text.includes('blender.crash.txt')
  );
}

export function buildCleanupPassthroughResult(modelPath: string): CleanupPassthroughResult {
  return {
    status: 'ok',
    glb_path: modelPath,
    obj_path: null,
    vertex_count_before: null,
    vertex_count_after: null,
    face_count_before: null,
    face_count_after: null,
    cleanup_passthrough: true,
  };
}
