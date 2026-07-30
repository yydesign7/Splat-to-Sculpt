export interface RecordedAssetResponse {
  success?: boolean;
  entry?: {
    fileUrl?: unknown;
  };
  error?: unknown;
}

export function resolveUploadedVideoServerPath(
  temporaryVideoServerPath: string,
  assetResponse: RecordedAssetResponse | null | undefined,
): string {
  const publishedUrl = assetResponse?.success === true ? assetResponse.entry?.fileUrl : null;
  return typeof publishedUrl === 'string' && publishedUrl.trim() ? publishedUrl : temporaryVideoServerPath;
}
