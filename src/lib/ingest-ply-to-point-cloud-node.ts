/**
 * Shared pipeline: upload PLY into the current ephemeral session, optionally run
 * segmentation, return final URLs + layer metadata for Point Cloud node `data`.
 */

export type ApiFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type IngestPlyToPointCloudNodeSuccess = {
  ok: true;
  plyUrl: string;
  pointCount: number;
  layerFiles: string[];
  layerNames: string[];
};

export type IngestPlyToPointCloudNodeFailure = {
  ok: false;
  errorMessage: string;
};

export type IngestPlyToPointCloudNodeResult =
  | IngestPlyToPointCloudNodeSuccess
  | IngestPlyToPointCloudNodeFailure;

export type IngestPlyToPointCloudNodeOptions = {
  apiFetch: ApiFetchFn;
  file: File | Blob;
  /** Display / upload filename (e.g. user-selected file name or asset name). */
  fileLabel: string;
  enableSegmentation: boolean;
  /**
   * Invoked after a successful upload, before optional segmentation.
   * Use to update UI (e.g. progressText "Segmenting…") while the segment request runs.
   */
  onUploadComplete?: (ctx: { plyUrl: string; pointCount: number }) => void | Promise<void>;
};

function coerceToFile(file: File | Blob, label: string): File {
  if (file instanceof File) return file;
  const safe = label.replace(/[/\\]/g, '_').trim() || 'pointcloud';
  const name = safe.toLowerCase().endsWith('.ply') ? safe : `${safe}.ply`;
  return new File([file], name, { type: 'application/octet-stream' });
}

export async function ingestPlyToPointCloudNode(
  options: IngestPlyToPointCloudNodeOptions,
): Promise<IngestPlyToPointCloudNodeResult> {
  const { apiFetch, file, fileLabel, enableSegmentation, onUploadComplete } = options;
  const uploadFile = coerceToFile(file, fileLabel);
  const formData = new FormData();
  formData.append('ply', uploadFile);

  let uploadJson: { success?: boolean; error?: string; plyUrl?: string; pointCount?: number };
  try {
    const res = await apiFetch('/api/upload-pointcloud', { method: 'POST', body: formData });
    uploadJson = (await res.json()) as typeof uploadJson;
  } catch (e) {
    return {
      ok: false,
      errorMessage: e instanceof Error ? e.message : 'Upload request failed',
    };
  }

  if (!uploadJson.success || !uploadJson.plyUrl) {
    return {
      ok: false,
      errorMessage: uploadJson.error || 'Upload failed',
    };
  }

  const pointCount = typeof uploadJson.pointCount === 'number' ? uploadJson.pointCount : 0;
  let plyUrl = uploadJson.plyUrl;
  let layerFiles: string[] = [];
  let layerNames: string[] = [];

  await onUploadComplete?.({ plyUrl, pointCount });

  if (enableSegmentation) {
    try {
      const segRes = await apiFetch('/api/segment-pointcloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plyPath: plyUrl, mode: 'segment_all' }),
      });
      const segResult = (await segRes.json()) as {
        success?: boolean;
        segmented?: boolean;
        plyUrl?: string;
        layerFiles?: string[];
        layerNames?: string[];
      };

      if (segResult.success) {
        plyUrl = segResult.plyUrl ?? plyUrl;
        layerFiles = Array.isArray(segResult.layerFiles) ? segResult.layerFiles : [];
        layerNames = Array.isArray(segResult.layerNames) ? segResult.layerNames : [];
      }
    } catch {
      /* keep upload-only result */
    }
  }

  return { ok: true, plyUrl, pointCount, layerFiles, layerNames };
}
