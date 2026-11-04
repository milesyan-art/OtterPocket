import type { Arrangement } from '../board/arrange';

/**
 * Layout previews: little boards (x, y, width, height on a 40 × 30 canvas) showing what each arrangement
 * looks like. Neighbours are 2 apart, and edges either line up exactly or are clearly apart: at this size an
 * edge that is off by one or two reads as a mistake.
 */
const SAMPLES: Record<Arrangement, [number, number, number, number][]> = {
  // A typical tidied board, casual rather than packed: a tall picture, two stacked, and a medium one, all
  // centred on the same middle line, with easy room above and below the single ones. Three columns, like
  // the other two previews.
  tidy: [
    [3, 8, 8, 14],
    [13, 3, 12, 9],
    [13, 14, 12, 13],
    [27, 10, 10, 10],
  ],
  // The same cell for everything, in even rows.
  grid: [
    [3, 3, 10, 11],
    [15, 3, 10, 11],
    [27, 3, 10, 11],
    [3, 16, 10, 11],
    [15, 16, 10, 11],
    [27, 16, 10, 11],
  ],
  // One width, stacked in columns.
  columns: [
    [3, 3, 10, 13],
    [3, 18, 10, 9],
    [15, 3, 10, 7],
    [15, 12, 10, 15],
    [27, 3, 10, 10],
    [27, 15, 10, 12],
  ],
};

export function LayoutSample({ kind }: { kind: Arrangement }) {
  return (
    <svg width={40} height={30} viewBox="0 0 40 30" aria-hidden>
      {SAMPLES[kind].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={1} fill="currentColor" />
      ))}
    </svg>
  );
}
