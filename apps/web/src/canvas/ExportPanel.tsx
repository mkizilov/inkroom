import { useState } from 'react';
import { regionSchema, type CanvasObject, type Region } from '@inkroom/shared';
import {
  ExportError,
  buildJsonText,
  buildPngBlob,
  buildSvgText,
  exportFileName,
} from '../export/build';
import { downloadBlob } from '../export/download';
import { EMPTY_BOARD_REGION, selectForExport, type ExportScope } from '../export/regions';

type Format = 'png' | 'svg' | 'json';

const PNG_SCALES = [1, 2, 3] as const;

// The region fields are text while they are being typed, so they are read back as numbers only when
// an export starts.
interface RegionFields {
  x: string;
  y: string;
  width: string;
  height: string;
}

const REGION_FIELDS: ReadonlyArray<{ key: keyof RegionFields; label: string }> = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'width', label: 'Width' },
  { key: 'height', label: 'Height' },
];

function fieldsOf(region: Region): RegionFields {
  return {
    x: String(region.x),
    y: String(region.y),
    width: String(region.width),
    height: String(region.height),
  };
}

function numberOf(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text);
}

// The region the fields describe, or null when they do not describe one with a positive size.
function regionOf(fields: RegionFields): Region | null {
  const region = {
    x: numberOf(fields.x),
    y: numberOf(fields.y),
    width: numberOf(fields.width),
    height: numberOf(fields.height),
  };
  if (!regionSchema.safeParse(region).success || region.width <= 0 || region.height <= 0) {
    return null;
  }
  return region;
}

interface ExportPanelProps {
  title: string;
  objects: readonly CanvasObject[];
  selectedIds: readonly string[];
  onClose: () => void;
}

// Downloads the whole board, the selected objects, or a region, as PNG, SVG or JSON. Everything is
// made in the page from the board as it is on screen, so nothing is sent to the server.
export function ExportPanel({ title, objects, selectedIds, onClose }: ExportPanelProps) {
  const [scope, setScope] = useState<ExportScope>('board');
  const [fields, setFields] = useState<RegionFields>(() =>
    fieldsOf(selectForExport('board', objects, [], EMPTY_BOARD_REGION).viewport),
  );
  const [scale, setScale] = useState<number>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(format: Format) {
    setError(null);
    setBusy(true);
    try {
      if (scope === 'selection' && selectedIds.length === 0) {
        throw new ExportError('Select objects on the canvas first.');
      }
      const region = regionOf(fields);
      if (scope === 'region' && region === null) {
        throw new ExportError('Enter a region with a width and height greater than zero.');
      }
      const selection = selectForExport(scope, objects, selectedIds, region ?? EMPTY_BOARD_REGION);
      const exportedAt = new Date().toISOString();
      if (format === 'json') {
        const text = buildJsonText(title, selection, exportedAt);
        downloadBlob(
          new Blob([text], { type: 'application/json' }),
          exportFileName(title, scope, 'json'),
        );
      } else if (format === 'svg') {
        const text = buildSvgText(title, selection);
        downloadBlob(
          new Blob([text], { type: 'image/svg+xml' }),
          exportFileName(title, scope, 'svg'),
        );
      } else {
        const blob = await buildPngBlob(title, selection, scale);
        downloadBlob(blob, exportFileName(title, scope, 'png'));
      }
    } catch (caught) {
      if (caught instanceof ExportError) {
        setError(caught.message);
      } else {
        console.error('The export failed.', caught);
        setError('The export failed. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Export" className="panel export-panel">
      <h2>Export</h2>
      <fieldset>
        <legend>What to export</legend>
        <label>
          <input
            type="radio"
            name="export-scope"
            value="board"
            checked={scope === 'board'}
            onChange={() => setScope('board')}
          />
          Whole board
        </label>
        <label>
          <input
            type="radio"
            name="export-scope"
            value="selection"
            checked={scope === 'selection'}
            disabled={selectedIds.length === 0}
            onChange={() => setScope('selection')}
          />
          Selected objects
        </label>
        <label>
          <input
            type="radio"
            name="export-scope"
            value="region"
            checked={scope === 'region'}
            onChange={() => setScope('region')}
          />
          Region
        </label>
      </fieldset>
      {scope === 'region' && (
        <fieldset>
          <legend>Region in board units</legend>
          {REGION_FIELDS.map(({ key, label }) => (
            <label key={key}>
              {label}
              <input
                type="number"
                name={`region-${key}`}
                value={fields[key]}
                onChange={(event) => {
                  const value = event.target.value;
                  setFields((current) => ({ ...current, [key]: value }));
                }}
              />
            </label>
          ))}
        </fieldset>
      )}
      <label>
        Scale for PNG
        <select value={scale} onChange={(event) => setScale(Number(event.target.value))}>
          {PNG_SCALES.map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </label>
      <div className="export-actions">
        <button type="button" disabled={busy} onClick={() => run('png')}>
          Download PNG
        </button>
        <button type="button" disabled={busy} onClick={() => run('svg')}>
          Download SVG
        </button>
        <button type="button" disabled={busy} onClick={() => run('json')}>
          Download JSON
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {busy && <p role="status">Preparing the file…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}
