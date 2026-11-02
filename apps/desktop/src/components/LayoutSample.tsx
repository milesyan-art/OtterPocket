import type { Arrangement } from '../board/arrange';

/** Little boards (x, y, width, height on a 40 × 30 canvas) showing what each arrangement looks like. */
const SAMPLES: Record<Arrangement, [number, number, number, number][]> = {
  // Mixed sizes kept as they are, edges lined up.
  tidy: [
    [3, 3, 15, 13],
    [20, 3, 17, 6],
    [20, 10, 9, 6],
    [31, 10, 6, 6],
    [3, 18, 9, 9],
    [14, 18, 23, 9],
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
    [27, 15, 10, 9],
  ],
};

export function LayoutSample({ kind }: { kind: Arrangement }) {
  return (
    <svg width={40} height={30} viewBox="0 0 40 30" aria-hidden>
      {SAMPLES[kind].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={1.5} fill="currentColor" />
      ))}
    </svg>
  );
}
