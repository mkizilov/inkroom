import type { CanvasObject, Region, TextObject } from '@inkroom/shared';

// The arrowhead is 10 units long and 10 units wide, as the scene draws it.
const ARROW_HEAD = 10;
const BACKGROUND = '#ffffff';
const FONT_FAMILY = 'sans-serif';

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// Escapes a value for XML text or an attribute. Every value written into the markup goes through here.
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character);
}

function num(value: number): string {
  return String(value);
}

function strokeAttributes(object: { stroke: string; strokeWidth: number }): string {
  return `stroke="${escapeXml(object.stroke)}" stroke-width="${num(object.strokeWidth)}"`;
}

function lineMarkup(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  style: { stroke: string; strokeWidth: number },
): string {
  return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" fill="none" ${strokeAttributes(style)} stroke-linecap="round"/>`;
}

// The three corners of the arrowhead at the end point, or null for an arrow with no length.
function arrowHeadPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): string | null {
  const length = Math.hypot(endX - startX, endY - startY);
  if (length === 0) {
    return null;
  }
  const ux = (endX - startX) / length;
  const uy = (endY - startY) / length;
  const baseX = endX - ux * ARROW_HEAD;
  const baseY = endY - uy * ARROW_HEAD;
  const sideX = (-uy * ARROW_HEAD) / 2;
  const sideY = (ux * ARROW_HEAD) / 2;
  const corners: Array<[number, number]> = [
    [endX, endY],
    [baseX + sideX, baseY + sideY],
    [baseX - sideX, baseY - sideY],
  ];
  return corners.map(([x, y]) => `${num(x)},${num(y)}`).join(' ');
}

// SVG has no line breaks inside a text element, so each line is a tspan. Lines are spaced by the font
// size, as the scene spaces them.
function textMarkup(object: TextObject): string {
  const x = num(object.x);
  const lines = object.text.split('\n').map((line, index) => {
    const dy = index === 0 ? 0 : object.fontSize;
    return `<tspan x="${x}" dy="${num(dy)}">${escapeXml(line)}</tspan>`;
  });
  return `<text x="${x}" y="${num(object.y)}" font-family="${FONT_FAMILY}" font-size="${num(object.fontSize)}" fill="${escapeXml(object.stroke)}" dominant-baseline="hanging" xml:space="preserve">${lines.join('')}</text>`;
}

// The markup for one object, in board coordinates. Pen points and line ends are stored relative to
// the object's position, so they are shifted here by that position.
function markup(object: CanvasObject): string[] {
  switch (object.type) {
    case 'pen': {
      const points = object.points
        .map((point) => `${num(object.x + point.x)},${num(object.y + point.y)}`)
        .join(' ');
      return [
        `<polyline points="${points}" fill="none" ${strokeAttributes(object)} stroke-linecap="round" stroke-linejoin="round"/>`,
      ];
    }
    case 'rectangle':
      return [
        `<rect x="${num(object.x)}" y="${num(object.y)}" width="${num(object.width)}" height="${num(object.height)}" fill="${escapeXml(object.fill ?? 'none')}" ${strokeAttributes(object)}/>`,
      ];
    case 'ellipse':
      return [
        `<ellipse cx="${num(object.x + object.width / 2)}" cy="${num(object.y + object.height / 2)}" rx="${num(object.width / 2)}" ry="${num(object.height / 2)}" fill="${escapeXml(object.fill ?? 'none')}" ${strokeAttributes(object)}/>`,
      ];
    case 'line':
      return [lineMarkup(object.x, object.y, object.x + object.dx, object.y + object.dy, object)];
    case 'arrow': {
      const endX = object.x + object.dx;
      const endY = object.y + object.dy;
      const lines = [lineMarkup(object.x, object.y, endX, endY, object)];
      const head = arrowHeadPoints(object.x, object.y, endX, endY);
      if (head !== null) {
        lines.push(`<polygon points="${head}" fill="${escapeXml(object.stroke)}" stroke="none"/>`);
      }
      return lines;
    }
    case 'text':
      return [textMarkup(object)];
  }
}

// Renders objects, back to front, into an SVG document. The viewBox is the region itself, so every
// object keeps its board coordinates and the picture is exactly the region.
export function renderSvg(
  objects: readonly CanvasObject[],
  region: Region,
  title?: string,
): string {
  const { x, y, width, height } = region;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(x)} ${num(y)} ${num(width)} ${num(height)}">`,
  ];
  if (title !== undefined) {
    lines.push(`<title>${escapeXml(title)}</title>`);
  }
  lines.push(
    `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${BACKGROUND}"/>`,
  );
  for (const object of objects) {
    lines.push(...markup(object));
  }
  lines.push('</svg>');
  return lines.join('\n');
}
