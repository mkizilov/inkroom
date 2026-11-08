import type { Region } from '@inkroom/shared';

// Draws an SVG picture onto a canvas at the given scale, and encodes the canvas as PNG. The picture is
// the same SVG the SVG export writes, so the two files show the same drawing. Browser only.
export async function renderPng(svg: string, region: Region, scale: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(region.width * scale);
    canvas.height = Math.round(region.height * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('This browser cannot draw the picture.');
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The picture could not be drawn.'));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('The picture could not be encoded.'));
      }
    }, 'image/png');
  });
}
