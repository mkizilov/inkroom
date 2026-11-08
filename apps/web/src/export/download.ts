// Starts a download of a file made in the page.
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Released after a moment, so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
