import { Arrow, Ellipse, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type { CanvasObject } from '@inkroom/shared';
import { objectBounds, type Rect as WorldRect } from './geometry';
import { HANDLES, HANDLE_SIZE_PX, handlePoint } from './transform';
import type { Viewport } from './viewport';

const SELECTION_COLOR = '#0969da';

interface CanvasSceneProps {
  width: number;
  height: number;
  viewport: Viewport;
  objects: readonly CanvasObject[];
  draft: CanvasObject | null;
  selectedIds: readonly string[];
  selectionBox: WorldRect | null;
  showHandles: boolean;
  marquee: WorldRect | null;
  hiddenTextId: string | null;
}

// Konva applies the viewport as the stage transform, so every object is drawn in world units.
// Nodes are not listening: the editor handles pointer input and picks objects itself.
function renderObject(object: CanvasObject, key: string) {
  switch (object.type) {
    case 'pen':
      return (
        <Line
          key={key}
          x={object.x}
          y={object.y}
          points={object.points.flatMap((point) => [point.x, point.y])}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      );
    case 'rectangle':
      return (
        <Rect
          key={key}
          x={object.x}
          y={object.y}
          width={object.width}
          height={object.height}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
          fill={object.fill}
          listening={false}
        />
      );
    case 'ellipse':
      return (
        <Ellipse
          key={key}
          x={object.x + object.width / 2}
          y={object.y + object.height / 2}
          radiusX={object.width / 2}
          radiusY={object.height / 2}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
          fill={object.fill}
          listening={false}
        />
      );
    case 'line':
      return (
        <Line
          key={key}
          x={object.x}
          y={object.y}
          points={[0, 0, object.dx, object.dy]}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
          lineCap="round"
          listening={false}
        />
      );
    case 'arrow':
      return (
        <Arrow
          key={key}
          x={object.x}
          y={object.y}
          points={[0, 0, object.dx, object.dy]}
          stroke={object.stroke}
          strokeWidth={object.strokeWidth}
          fill={object.stroke}
          pointerLength={10}
          pointerWidth={10}
          listening={false}
        />
      );
    case 'text':
      return (
        <Text
          key={key}
          x={object.x}
          y={object.y}
          text={object.text}
          fontSize={object.fontSize}
          fill={object.stroke}
          listening={false}
        />
      );
  }
}

export function CanvasScene({
  width,
  height,
  viewport,
  objects,
  draft,
  selectedIds,
  selectionBox,
  showHandles,
  marquee,
  hiddenTextId,
}: CanvasSceneProps) {
  const selected = objects.filter((object) => selectedIds.includes(object.id));
  // Handles keep a constant on-screen size as the zoom changes.
  const handleSize = HANDLE_SIZE_PX / viewport.scale;

  return (
    <Stage
      width={width}
      height={height}
      x={viewport.offsetX}
      y={viewport.offsetY}
      scaleX={viewport.scale}
      scaleY={viewport.scale}
      listening={false}
    >
      <Layer listening={false}>
        {objects
          .filter((object) => object.id !== hiddenTextId)
          .map((object) => renderObject(object, object.id))}
        {draft && (
          <Group opacity={0.6} listening={false}>
            {renderObject(draft, draft.id)}
          </Group>
        )}
        {selected.map((object) => {
          const bounds = objectBounds(object);
          return (
            <Rect
              key={`outline-${object.id}`}
              x={bounds.x}
              y={bounds.y}
              width={bounds.width}
              height={bounds.height}
              stroke={SELECTION_COLOR}
              strokeWidth={1}
              strokeScaleEnabled={false}
              dash={[6, 4]}
              listening={false}
            />
          );
        })}
        {selectionBox && (
          <Rect
            x={selectionBox.x}
            y={selectionBox.y}
            width={selectionBox.width}
            height={selectionBox.height}
            stroke={SELECTION_COLOR}
            strokeWidth={1}
            strokeScaleEnabled={false}
            listening={false}
          />
        )}
        {selectionBox &&
          showHandles &&
          HANDLES.map((handle) => {
            const anchor = handlePoint(selectionBox, handle);
            return (
              <Rect
                key={`handle-${handle}`}
                x={anchor.x - handleSize / 2}
                y={anchor.y - handleSize / 2}
                width={handleSize}
                height={handleSize}
                fill="#ffffff"
                stroke={SELECTION_COLOR}
                strokeWidth={1}
                strokeScaleEnabled={false}
                listening={false}
              />
            );
          })}
        {marquee && (
          <Rect
            x={marquee.x}
            y={marquee.y}
            width={marquee.width}
            height={marquee.height}
            stroke={SELECTION_COLOR}
            strokeWidth={1}
            strokeScaleEnabled={false}
            fill="rgba(9, 105, 218, 0.08)"
            dash={[4, 4]}
            listening={false}
          />
        )}
      </Layer>
    </Stage>
  );
}
