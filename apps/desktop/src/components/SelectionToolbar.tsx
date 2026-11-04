import { useLayoutEffect, useRef, useState } from 'react';
import type { ScreenRect } from '../board/Board';
import { ToolBar, type Tool } from './FloatingToolbar';

/** Room (px) between the selection's box and the bar, and kept clear at the board's edges. */
const GAP = 10;
const EDGE = 8;
/** The height at the bottom of the board taken by the tools floating there, which the bar stays above. */
const DOCK = 80;
/** About how tall a tool's menu is: it opens upward when there's this much room above the bar. */
const MENU_ROOM = 180;

interface Props {
  /** The box around the selection, in the board's screen pixels. */
  around: ScreenRect;
  /** The board's size on screen. */
  area: { width: number; height: number };
  count: number;
  groups: Tool[][];
}

/**
 * Tools for what's selected, floating just above the box around the selection, or below it when there's no
 * room above, so what they act on is plain to see. It follows the selection as the board moves.
 */
export function SelectionToolbar({ around, area, count, groups }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState({ width: 0, height: 0 });
  // The bar's own size decides where it fits. Measured before it is painted, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.float-toolbar');
    if (el && (el.offsetWidth !== bar.width || el.offsetHeight !== bar.height)) {
      setBar({ width: el.offsetWidth, height: el.offsetHeight });
    }
  });

  const offScreen =
    around.x + around.width < 0 || around.y + around.height < 0 || around.x > area.width || around.y > area.height;
  if (offScreen) return null;

  const bottom = area.height - DOCK;
  const above = around.y - GAP - bar.height >= EDGE;
  const below = !above && around.y + around.height + GAP + bar.height <= bottom;
  // Neither fits when the selection fills the screen: then the bar sits inside it, at the top of what's in view.
  const top = above
    ? Math.min(around.y - GAP - bar.height, bottom - bar.height)
    : below
      ? around.y + around.height + GAP
      : clamp(around.y + GAP, EDGE, bottom - bar.height);
  const left = clamp(around.x + around.width / 2, EDGE + bar.width / 2, area.width - EDGE - bar.width / 2);
  // The menu opens away from the selection, unless the edge of the board is too near on that side.
  const roomAbove = top - EDGE;
  const roomBelow = bottom - top - bar.height;
  const [away, toward] = above ? (['above', 'below'] as const) : (['below', 'above'] as const);
  const roomAway = above ? roomAbove : roomBelow;
  const menuSide = roomAway >= MENU_ROOM || roomAway >= (above ? roomBelow : roomAbove) ? away : toward;

  return (
    <div ref={ref} className={`selection-tools menu-${menuSide}`} style={{ left, top }}>
      <ToolBar
        groups={groups}
        menuSide={menuSide}
        label="Selection"
        start={<span className="selection-count">{count} selected</span>}
      />
    </div>
  );
}

/** `value` kept between `min` and `max`; `min` wins when there's no room between them. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
