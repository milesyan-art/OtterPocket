/**
 * The ways the Arrange tool can put a board in order. Each reads the items where they sit and says where
 * each one goes and how big it is. The result keeps the board's top-left corner, so nothing jumps off
 * screen, and arranging an arranged board the same way again changes nothing.
 *
 * - tidy: keep the arrangement someone made, just straighten it out. Sizes never change.
 * - grid: every item fitted into the same cell, in even rows, like a contact sheet.
 * - columns: every item the same width, stacked in columns of about equal height.
 *
 * Grid and columns keep the board's overall shape and keep items roughly on their side of it.
 */

export type Arrangement = 'tidy' | 'grid' | 'columns';

/** An item's footprint on the board, in board units, as shown (scale applied). */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Axis = 'x' | 'y';
/** Which side of a row (top, middle, bottom) or column (left, middle, right) its parts line up on. */
type Align = 'start' | 'middle' | 'end';

/** A laid-out group: its size and where each item sits, relative to the group's top-left. */
interface Laid {
  w: number;
  h: number;
  spots: Map<string, Box>;
}

interface Spacing {
  gap: number;
  /** A deliberate empty stretch between groups: kept, at this size, so clusters stay apart. */
  section: number;
}

/** The even gap, as a share of a typical item's shorter side (or of the cell, or the column width). */
const GAP = 0.06;
/** Space at least this share of a typical item's shorter side was left on purpose. */
const SECTION = 0.75;
/**
 * How forgiving a lane of empty space is: each item counts as only the middle of itself, so items that
 * were dropped slightly overlapping still split into rows. The later steps are for boards that are one big pile.
 */
const INSETS = [0.3, 0.6];
/**
 * Columns: a column this much shorter than another (as a share of the column width) doesn't win the next
 * item outright; the one nearest where the item was does.
 */
const SLACK = 0.4;

export function arrange(kind: Arrangement, boxes: Box[]): Map<string, Box> {
  if (boxes.length === 0) return new Map();
  const laid = kind === 'tidy' ? tidy(boxes) : kind === 'grid' ? grid(boxes) : columns(boxes);
  const from = bounds(boxes);
  const to = bounds(laid);
  return new Map(laid.map((b) => [b.id, { ...b, x: from.x + b.x - to.x, y: from.y + b.y - to.y }]));
}

/**
 * Brings scattered items together into a compact block, keeping their sizes and reading order: rows of
 * about √n with the even gap, like a pile dealt out. The block starts at the items' top-left corner.
 */
export function gather(boxes: Box[]): Map<string, Box> {
  if (boxes.length === 0) return new Map();
  const typical = median(boxes.map((b) => Math.min(b.w, b.h)));
  const laid = pile(boxes, { gap: typical * GAP, section: typical * SECTION });
  const from = bounds(boxes);
  return new Map([...laid.spots].map(([id, b]) => [id, { ...b, x: from.x + b.x, y: from.y + b.y }]));
}

/**
 * The top-left corner nearest `near` where a block `w` × `h` covers none of `obstacles`, keeping `gap`
 * from each: `near` itself when that is clear, or else a spot beside, above or below one of them.
 */
export function freeSpot(w: number, h: number, near: { x: number; y: number }, obstacles: Box[], gap: number) {
  const clear = (x: number, y: number) =>
    obstacles.every((o) => x + w + gap <= o.x || o.x + o.w + gap <= x || y + h + gap <= o.y || o.y + o.h + gap <= y);
  if (clear(near.x, near.y)) return near;
  const candidates: { x: number; y: number }[] = [];
  for (const o of obstacles) {
    const right = o.x + o.w + gap;
    const left = o.x - w - gap;
    const below = o.y + o.h + gap;
    const above = o.y - h - gap;
    candidates.push(
      { x: right, y: near.y }, { x: right, y: o.y },
      { x: left, y: near.y }, { x: left, y: o.y },
      { x: near.x, y: below }, { x: o.x, y: below },
      { x: near.x, y: above }, { x: o.x, y: above },
    );
  }
  // Past everything on the right is always clear.
  let best = { x: Math.max(...obstacles.map((o) => o.x + o.w)) + gap, y: near.y };
  let bestDistance = Math.hypot(best.x - near.x, best.y - near.y);
  for (const c of candidates) {
    const distance = Math.hypot(c.x - near.x, c.y - near.y);
    if (distance < bestDistance && clear(c.x, c.y)) {
      best = c;
      bestDistance = distance;
    }
  }
  return best;
}

// ---- tidy ------------------------------------------------------------------------------
//
// The board is read the way a page is read for its layout (a recursive XY cut): find the clear lanes of
// empty space that split the items into rows or columns, then do the same inside each of those. Rows are
// laid out left to right, columns top to bottom, with one even gap throughout, and each lines up on the
// edge it was already lined up on: a column hugging a gutter on its right stays flush right.

function tidy(boxes: Box[]): Box[] {
  const typical = median(boxes.map((b) => Math.min(b.w, b.h)));
  const spacing = { gap: typical * GAP, section: typical * SECTION };
  // A messy board can read a little differently once it is straightened (a pile inside a row becomes part
  // of the row), so straighten the result again until it holds still: pressing Tidy up twice moves nothing.
  let laid = straighten(boxes, spacing).spots;
  for (let pass = 0; pass < 8; pass++) {
    const again = straighten([...laid.values()], spacing).spots;
    const still = [...laid.values()].every((b) => {
      const a = again.get(b.id)!;
      return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
    });
    if (still) break;
    laid = again;
  }
  return [...laid.values()];
}

function straighten(boxes: Box[], spacing: Spacing): Laid {
  if (boxes.length === 1) return leaf(boxes[0]!);
  for (const inset of INSETS) {
    const options: Laid[] = [];
    for (const axis of ['y', 'x'] as const) {
      const { groups, gaps } = split(boxes, axis, inset);
      if (groups.length < 2) continue;
      const between = gaps.map((g) => (g >= spacing.section * 0.999 ? spacing.section : spacing.gap));
      const align = alignment(groups, axis === 'x' ? 'y' : 'x');
      options.push(line(groups.map((group) => straighten(group, spacing)), axis, between, align));
    }
    // A grid splits both ways; keep whichever reading moves things least.
    if (options.length > 0) return closest(options, boxes);
  }
  return pile(boxes, spacing);
}

/**
 * Splits along `axis` wherever no item crosses, in order. `gaps` holds the empty space that was between
 * each pair of neighbouring groups (negative where they overlapped a little).
 */
function split(boxes: Box[], axis: Axis, inset: number): { groups: Box[][]; gaps: number[] } {
  const start = (b: Box) => (axis === 'x' ? b.x : b.y);
  const size = (b: Box) => (axis === 'x' ? b.w : b.h);
  const trim = (b: Box) => (size(b) * inset) / 2;
  const sorted = [...boxes].sort((a, b) => start(a) + trim(a) - (start(b) + trim(b)));
  const groups: Box[][] = [];
  let reach = -Infinity;
  for (const b of sorted) {
    if (start(b) + trim(b) >= reach) groups.push([]);
    groups[groups.length - 1]!.push(b);
    reach = Math.max(reach, start(b) + size(b) - trim(b));
  }
  const gaps = groups.slice(1).map((group, i) => {
    const end = Math.max(...groups[i]!.map((b) => start(b) + size(b)));
    return Math.min(...group.map(start)) - end;
  });
  return { groups, gaps };
}

/**
 * The edge (or middle) the groups already come closest to sharing, measured `across` the line they form.
 * Ties go to the near edge, so items that line up every way stay top- or left-aligned.
 */
function alignment(groups: Box[][], across: Axis): Align {
  const spans = groups.map((group) => ({
    lo: Math.min(...group.map((b) => (across === 'x' ? b.x : b.y))),
    hi: Math.max(...group.map((b) => (across === 'x' ? b.x + b.w : b.y + b.h))),
  }));
  const spread = (at: (span: { lo: number; hi: number }) => number) =>
    Math.max(...spans.map(at)) - Math.min(...spans.map(at));
  const options: [Align, number][] = [
    ['start', spread((s) => s.lo)],
    ['end', spread((s) => s.hi)],
    ['middle', spread((s) => (s.lo + s.hi) / 2)],
  ];
  return options.reduce((best, option) => (option[1] < best[1] - 1e-6 ? option : best))[0];
}

/** Parts side by side (`x`) or one under another (`y`), lined up across the line by `align`. */
function line(parts: Laid[], axis: Axis, gaps: number[], align: Align = 'start'): Laid {
  const depth = (part: Laid) => (axis === 'x' ? part.h : part.w);
  const across = Math.max(...parts.map(depth));
  const spots = new Map<string, Box>();
  let along = 0;
  parts.forEach((part, i) => {
    if (i > 0) along += gaps[i - 1]!;
    const room = across - depth(part);
    const shift = align === 'start' ? 0 : align === 'end' ? room : room / 2;
    for (const [id, p] of part.spots) {
      spots.set(id, axis === 'x' ? { ...p, x: along + p.x, y: shift + p.y } : { ...p, x: shift + p.x, y: along + p.y });
    }
    along += axis === 'x' ? part.w : part.h;
  });
  return axis === 'x' ? { w: along, h: across, spots } : { w: across, h: along, spots };
}

/** Items piled on top of each other have no order to keep: deal them out in a square-ish grid. */
function pile(boxes: Box[], spacing: Spacing): Laid {
  const laidRows = rows(boxes, Math.ceil(Math.sqrt(boxes.length))).map((row) =>
    line(row.map(leaf), 'x', row.map(() => spacing.gap)),
  );
  return line(laidRows, 'y', laidRows.map(() => spacing.gap));
}

function leaf(b: Box): Laid {
  return { w: b.w, h: b.h, spots: new Map([[b.id, { ...b, x: 0, y: 0 }]]) };
}

/** The layout that leaves items nearest to where they were, measured from the group's top-left. */
function closest(options: Laid[], boxes: Box[]): Laid {
  const { x: left, y: top } = bounds(boxes);
  const cost = (laid: Laid) =>
    boxes.reduce((sum, b) => {
      const p = laid.spots.get(b.id)!;
      return sum + (b.x - left - p.x) ** 2 + (b.y - top - p.y) ** 2;
    }, 0);
  return options.reduce((best, option) => (cost(option) < cost(best) ? option : best));
}

// ---- grid ------------------------------------------------------------------------------

function grid(boxes: Box[]): Box[] {
  // Cells take the most common shape, sized so a typical item just fills one; every item fits inside its
  // cell, centred. (Sizing by "the cell this item needs" keeps a second run from shrinking the grid.)
  const aspect = median(boxes.map((b) => b.w / b.h));
  const cellH = median(boxes.map((b) => Math.max(b.h, b.w / aspect)));
  const cellW = cellH * aspect;
  const gap = Math.min(cellW, cellH) * GAP;
  return closestShape(boxes, (perRow) =>
    rows(boxes, perRow).flatMap((row, r) =>
      row.map((b, c) => {
        const fit = Math.min(cellW / b.w, cellH / b.h);
        const w = b.w * fit;
        const h = b.h * fit;
        return { id: b.id, x: c * (cellW + gap) + (cellW - w) / 2, y: r * (cellH + gap) + (cellH - h) / 2, w, h };
      }),
    ),
  );
}

/** Reading order in rows of `perRow`: top to bottom, then left to right within each row. */
function rows(boxes: Box[], perRow: number): Box[][] {
  const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const out: Box[][] = [];
  for (let i = 0; i < sorted.length; i += perRow) {
    out.push(sorted.slice(i, i + perRow).sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2)));
  }
  return out;
}

// ---- columns ---------------------------------------------------------------------------

function columns(boxes: Box[]): Box[] {
  const width = median(boxes.map((b) => b.w));
  const gap = width * GAP;
  const area = bounds(boxes);
  const order = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  return closestShape(boxes, (count) => {
    const heights = new Array<number>(count).fill(0);
    return order.map((b) => {
      const h = (b.h * width) / b.w;
      const lowest = Math.min(...heights);
      // Which column the item was over, counting from 0 at the left edge of the board.
      const was = ((b.x + b.w / 2 - area.x) / area.w) * count - 0.5;
      let pick = -1;
      heights.forEach((top, i) => {
        if (top > lowest + width * SLACK) return;
        if (pick < 0 || Math.abs(i - was) < Math.abs(pick - was)) pick = i;
      });
      const spot = { id: b.id, x: pick * (width + gap), y: heights[pick]!, w: width, h };
      heights[pick] = spot.y + h + gap;
      return spot;
    });
  });
}

// ---- shared ----------------------------------------------------------------------------

/**
 * Of the layouts with 1, 2, 3… across, the one whose overall shape is nearest the board's now, so a tall
 * board stays tall and a wide one wide.
 */
function closestShape(boxes: Box[], layoutFor: (across: number) => Box[]): Box[] {
  const shape = (b: Box) => Math.log(b.w / b.h);
  const target = shape(bounds(boxes));
  const most = Math.min(boxes.length, 2 * Math.ceil(Math.sqrt(boxes.length)) + 2);
  let best: Box[] = [];
  let bestOff = Infinity;
  for (let across = 1; across <= most; across++) {
    const laid = layoutFor(across);
    const off = Math.abs(shape(bounds(laid)) - target);
    if (off < bestOff - 1e-9) {
      best = laid;
      bestOff = off;
    }
  }
  return best;
}

function bounds(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - x;
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
  return { id: '', x, y, w, h };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
