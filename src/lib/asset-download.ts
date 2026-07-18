function clickDownloadLink(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function buildAssetDownloadFilename(name: string, fileUrl: string): string {
  const trimmedName = name.trim() || 'asset';
  if (/\.[a-zA-Z0-9]{1,10}$/.test(trimmedName)) return trimmedName;

  try {
    const pathname = new URL(fileUrl, 'http://localhost').pathname;
    const extension = pathname.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1];
    return extension ? `${trimmedName}.${extension.toLowerCase()}` : trimmedName;
  } catch {
    return trimmedName;
  }
}

export async function downloadAssetFile(url: string, filename: string): Promise<void> {
  if (url.startsWith('blob:')) {
    clickDownloadLink(url, filename);
    return;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    clickDownloadLink(objectUrl, filename);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
