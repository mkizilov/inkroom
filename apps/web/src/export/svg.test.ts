import { describe, expect, it } from 'vitest';
import type { CanvasObject } from '@inkroom/shared';
import { escapeXml, renderSvg } from './svg';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const region = { x: -50, y: 100, width: 800, height: 600 };

describe('renderSvg', () => {
  it('uses the region as the viewBox, so coordinates are the board coordinates', () => {
    const svg = renderSvg([], region);

    expect(svg).toContain('width="800" height="600" viewBox="-50 100 800 600"');
    expect(svg).toContain('<rect x="-50" y="100" width="800" height="600" fill="#ffffff"/>');
  });

  it('keeps the position and size of rectangles and ellipses', () => {
    const objects: CanvasObject[] = [
      {
        id: id(1),
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 60,
        stroke: '#1971c2',
        strokeWidth: 2,
        fill: '#a5d8ff',
      },
      {
        id: id(2),
        type: 'ellipse',
        x: 0,
        y: 0,
        width: 80,
        height: 40,
        stroke: '#2f9e44',
        strokeWidth: 3,
      },
    ];

    const svg = renderSvg(objects, region);

    expect(svg).toContain(
      '<rect x="10" y="20" width="100" height="60" fill="#a5d8ff" stroke="#1971c2" stroke-width="2"/>',
    );
    expect(svg).toContain(
      '<ellipse cx="40" cy="20" rx="40" ry="20" fill="none" stroke="#2f9e44" stroke-width="3"/>',
    );
  });

  it('moves pen points and line ends by the object position, so they land where the scene draws them', () => {
    const objects: CanvasObject[] = [
      {
        id: id(1),
        type: 'pen',
        x: 200,
        y: 300,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: -3 },
        ],
        stroke: '#000000',
        strokeWidth: 1,
      },
      { id: id(2), type: 'line', x: 10, y: 20, dx: 30, dy: -40, stroke: '#000000', strokeWidth: 2 },
    ];

    const svg = renderSvg(objects, region);

    expect(svg).toContain('points="200,300 205,297"');
    expect(svg).toContain('<line x1="10" y1="20" x2="40" y2="-20"');
  });

  it('draws an arrow as a shaft and a filled head at its end point', () => {
    const arrow: CanvasObject = {
      id: id(1),
      type: 'arrow',
      x: 0,
      y: 0,
      dx: 100,
      dy: 0,
      stroke: '#e03131',
      strokeWidth: 2,
    };

    const svg = renderSvg([arrow], region);

    expect(svg).toContain('<line x1="0" y1="0" x2="100" y2="0"');
    // The head ends at (100, 0) and is 10 units long, with its base 10 units wide.
    expect(svg).toContain('<polygon points="100,0 90,5 90,-5" fill="#e03131" stroke="none"/>');
  });

  it('places text at its position, one tspan per line, and escapes what it contains', () => {
    const text: CanvasObject = {
      id: id(1),
      type: 'text',
      x: 30,
      y: 40,
      text: 'Café <b>"x"</b> & more\nsecond',
      stroke: '#1e1e1e',
      strokeWidth: 1,
      fontSize: 20,
    };

    const svg = renderSvg([text], region);

    expect(svg).toContain('<text x="30" y="40"');
    expect(svg).toContain(
      '<tspan x="30" dy="0">Café &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; more</tspan>',
    );
    expect(svg).toContain('<tspan x="30" dy="20">second</tspan>');
    expect(svg).not.toContain('<b>');
  });

  it('draws objects back to front, in the order given', () => {
    const back = {
      id: id(1),
      type: 'rectangle' as const,
      x: 0,
      y: 0,
      width: 5,
      height: 5,
      stroke: '#000000',
      strokeWidth: 1,
    };
    const front = { ...back, id: id(2), x: 50 };

    const svg = renderSvg([back, front], region);

    expect(svg.indexOf('x="0" y="0"')).toBeLessThan(svg.indexOf('x="50" y="0"'));
  });

  it('writes the title escaped, and a picture of an empty board as just the background', () => {
    const svg = renderSvg([], region, 'Plans <draft> & more');

    expect(svg).toContain('<title>Plans &lt;draft&gt; &amp; more</title>');
    expect(svg.split('\n')).toHaveLength(4);
  });
});

describe('escapeXml', () => {
  it('escapes the five characters that are special in XML', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
  });
});
