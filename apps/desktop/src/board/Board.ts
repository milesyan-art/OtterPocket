import {
  Application,
  CanvasTextMetrics,
  ColorMatrixFilter,
  Container,
  Graphics,
  ImageSource,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TextStyle,
  type FederatedPointerEvent,
  type PointData,
} from 'pixi.js';
import { ITEM_KIND_LABELS, siteName } from '@otterpocket/shared';
import { api, assetUrl, type BoardItem, type BoardView, type Group, type Item, type LayoutUpdate } from '../api';
import { median, type Box } from './arrange';

/**
 * Saved pages (articles and artists) are bookmark cards, in board units: as wide as a typical preview
 * picture, so they sit among the pictures around them at a readable size. The page's picture fills the
 * top and a caption with its title and site sits below; a page saved without a picture is a text card.
 * Must match natural_size in library.rs.
 */
const BOOKMARK = {
  w: 1200,
  caption: 280,
  textOnly: 600,
  /** Pictures narrower than this (a site's icon, a profile photo) sit small in a band this tall, not filling the top. */
  smallPicture: 480,
  band: 600,
  radius: 28,
};
/** How long an item takes to slide to a place the app gave it, such as after tidying up. */
const GLIDE_MS = 280;
/** How long the view takes to slide over to a newly saved item. */
const REVEAL_MS = 450;
/** Each ring that swells out of a newly saved item once it is in sight, and how far apart they start. */
const RIPPLE_MS = 900;
const RIPPLE_GAP_MS = 300;
/** Room (screen px) kept around a newly saved item brought into view: more at the bottom, where the tools float. */
const REVEAL_PAD = { side: 56, top: 56, bottom: 120 };
/**
 * How much of the canvas a reference alone on its board takes when it's shown to you, in its longer
 * direction. Filling the screen made a first save look too big: testers shrank the picture instead of
 * zooming out, and everything later was sized to match the shrunken one.
 */
const LONE_SHARE = 0.5;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const MIN_ITEM_SCALE = 0.05;
const DOUBLE_CLICK_MS = 350;
/** How far (screen px) the pointer travels before a press becomes a drag, so a click never nudges anything. */
const DRAG_THRESHOLD = 4;
/** How long a reference dragged out of its group is held still out there before it leaves the group. */
const DWELL_TO_LEAVE_MS = 500;
/** How far (screen px) the pointer may drift while held still, as a hand on a trackpad or mouse never quite stops. */
const DWELL_SLOP = 6;
/**
 * With ⌥ held at the press, the other way out (being tried against resting outside): hold the reference still
 * this long before moving, and it lifts free; let go wholly outside its group's frame and it leaves.
 */
const HOLD_TO_LIFT_MS = 450;
/** How far (screen px) the pointer may wander during that hold, as pressing a trackpad or button nudges it. */
const HOLD_SLOP = 10;
/** How much bigger a reference that has come out of its group is drawn, about its centre: it's been picked up. */
const LIFT_SCALE = 1.04;
/** Wheel events closer together than this belong to one gesture, including a trackpad's glide after the fingers lift. */
const WHEEL_GESTURE_GAP_MS = 150;
/** Room (screen px) between the box drawn around several selected items and the items. */
const GROUP_PAD = 6;
/**
 * A group's title bar, in screen px: it stays one size whatever the zoom, sits on top of the frame across its
 * whole width, and pressing anywhere on it picks up the group. Styled like the floating toolbars (their
 * panel colour, hairline edges, 6px corners, 12.5px text). It takes no room on the board, so a frame is only
 * its references and the room around them, the same shape at every zoom. Below `minFrame` wide on screen
 * the frame is too small to carry a bar and is drawn without one.
 */
const GROUP_BAR = { height: 28, text: 12.5, line: 16, inset: 10, radius: 6, minFrame: 56 };
/**
 * Room inside a group's frame around its references, as a share of their typical shorter side: the even gap
 * Tidy up leaves between references, so small pictures get a snug frame and 4K frames a roomier one. A fixed
 * size here looked huge around references someone had made small.
 */
const GROUP_PAD_SHARE = 0.06;
/**
 * Room kept free above a group's frame for its title bar when the app lays groups out (arranging, gathering
 * a new group), as a share of the same typical side. The bar's size on the board changes with the zoom, so
 * this covers the usual zooms; zoomed far out, a bar may lie over what's above it.
 */
const GROUP_LABEL_ROOM_SHARE = 0.2;
/**
 * A group's frame and label sit just under its lowest reference (stacking orders are whole numbers), so a
 * group brought to the front brings its frame along, over the groups and references it now covers.
 */
const GROUP_LAYER = { frame: -0.5, label: -0.4, handle: -0.3 };
const BOARD_BG = 0x141417;
const ACCENT = 0x8fb3ff;
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardEvents {
  /**
   * What is selected now, in the order it was picked; empty when nothing is. `groupId` is the group whose title
   * was pressed to pick it, so a group of one reference picked by its title is the group, not the reference.
   */
  select(itemIds: string[], groupId: string | null): void;
  /** An item was clicked on its own (no Shift or ⌘) and let go without being moved, and is now all that's selected. */
  clicked(itemId: string): void;
  layoutChanged(updates: LayoutUpdate[]): void;
  /**
   * A drag left `itemIds` wholly outside their groups' frames: they leave their groups, and `updates` is where
   * the drag left everything it moved, to be saved together as one step.
   */
  leftGroups(updates: LayoutUpdate[], itemIds: string[]): void;
  openSource(itemId: string): void;
  /**
   * Where the selection is on screen, so React can float things by it: the selected item, or the box around
   * several. `held` while it is being moved, scaled or boxed in, or while the press that made it is still down:
   * tools floating by it keep out of the way until it is let go.
   */
  selectionMoved(rect: ScreenRect | null, held: boolean): void;
  /** The person panned, zoomed or fitted the board. Not called for the automatic fit of a board's first visit. */
  viewChanged(boardId: string, view: BoardView): void;
  /** A newly saved item asked for with `reveal` is now on screen. */
  revealed(itemId: string): void;
  /** A group's title was double-clicked. */
  renameGroup(groupId: string): void;
  /**
   * Where the title being edited sits on screen, and how big its letters are there, so React can put a
   * text field over it. Null when no title is being edited, or its group isn't on the board.
   */
  titleMoved(rect: ScreenRect | null, fontSize: number): void;
}

interface Node {
  id: string;
  root: Container;
  /** Size in world units before the placement's scale. */
  w: number;
  h: number;
  data: BoardItem;
}

interface GroupView {
  id: string;
  title: string;
  frame: Graphics;
  label: Container;
  /** Where the title is: pressing it picks up the whole group. */
  handle: Container;
  text: Text;
  /** The width the title was last fitted into, so it is only measured again when that changes. */
  fittedTo: number;
  /** The frame where it was last drawn, in board units; null when the group has nothing on this board. */
  box: ScreenRect | null;
}

interface Glide {
  from: { x: number; y: number; scale: number };
  start: number;
}

interface ViewGlide {
  from: BoardView;
  to: BoardView;
  start: number;
}

interface Spot {
  x: number;
  y: number;
  scale: number;
}

type Drag =
  | {
      kind: 'move';
      /** Everything that moves: the whole selection. */
      ids: string[];
      /** The item under the pointer; empty when the press was on a group's title. */
      pressed: string;
      /** The group whose title was pressed, if that is what the press was on. */
      pressedGroup: string | null;
      /** Where the press was, in board units. */
      grab: PointData;
      from: Map<string, Spot>;
      /** Items brought to the front by the press, whose new order needs saving even if nothing moves. */
      raised: string[];
      /**
       * For each group only some of whose references are moving, its frame as it was at the press. A reference
       * carried wholly outside it and held still there comes out of the group.
       */
      homes: Map<string, ScreenRect>;
      /**
       * Held still outside its group long enough that the reference came out: let go out there, it leaves the
       * group. Until then a drag only arranges, however far it goes, and the frame grows to fit.
       */
      lifted: boolean;
      /** Where the pointer came to rest outside the group, waiting to see if it stays; null when it isn't. */
      dwellAt: PointData | null;
      /**
       * ⌥ was held at the press: the reference comes out by being held still first (it lifts), then dropped
       * wholly outside its group's frame, rather than by resting outside it.
       */
      holdFirst: boolean;
      /** How far the pointer has carried everything, in board units. */
      shift: PointData;
      start: PointData;
      moved: boolean;
      /** A plain press: let go without moving, it is a click, and selects just the pressed item (or group). */
      plain: boolean;
      /**
       * The press made a new selection. Tools floating by the selection wait until it is let go, rather than
       * popping up for the moment before a drag begins and vanishing again.
       */
      fresh: boolean;
    }
  | { kind: 'scale'; ids: string[]; anchor: PointData; startDistance: number; from: Map<string, Spot>; minFactor: number }
  | { kind: 'pan'; start: PointData; startPos: PointData; moved: boolean }
  | {
      kind: 'select';
      /** The corner the box is pulled from, in board units. */
      origin: PointData;
      start: PointData;
      /** What stays selected whatever the box covers: the selection at the press when Shift or ⌘ was held. */
      kept: string[];
      moved: boolean;
    };

/**
 * An infinite canvas rendered with PixiJS (WebGL), so large boards of big images
 * stay smooth. React owns the data; this class owns the view and reports layout edits back.
 */
export class Board {
  private app = new Application();
  private world = new Container({ sortableChildren: true });
  private selectionOutline = new Graphics();
  /** The box pulled out over the board to select what it touches, drawn in screen pixels above everything. */
  private selectionBox = new Graphics();
  private rippleRings = new Graphics();
  private scaleHandle = new Graphics();
  private grayscaleFilter = new ColorMatrixFilter();
  private nodes = new Map<string, Node>();
  private groups = new Map<string, GroupView>();
  private groupList: Group[] = [];
  /** The group whose title React is editing in a text field; its own title is hidden meanwhile. */
  private editingGroup: string | null = null;
  /** The group whose title the pointer is over, shown lighter so it reads as the handle. */
  private hoveredGroup: string | null = null;
  private glides = new Map<string, Glide>();
  private viewGlide: ViewGlide | null = null;
  /** A newly saved item to bring into view as soon as it is on this board. */
  private pendingReveal: { boardId: string; itemId: string } | null = null;
  private ripple: { id: string; start: number } | null = null;
  private textures = new Map<string, Promise<Texture>>();
  private favicons = new Map<string, Promise<Texture | null>>();
  private resizeObserver?: ResizeObserver;
  private host: HTMLElement | null = null;

  private ready = false;
  private destroyed = false;
  private boardId: string | null = null;
  private items: BoardItem[] = [];
  /** In the order it was picked. */
  private selected: string[] = [];
  /** References being dragged wholly out of their group's frame: drawn as out of it already, and taken out on release. */
  private leaving = new Set<string>();
  /** Waiting for a reference dragged out of its group to be held still out there long enough to come out. */
  private dwellTimer = 0;
  /** With ⌥: waiting for a press on a reference to be held still long enough to lift it. */
  private holdTimer = 0;

  /** The group picked by its title, when that is what the selection is. */
  private pickedGroup: string | null = null;
  private grayscale = false;
  private needsFit = true;
  /** The view to restore once the canvas is ready: where this board was left last time. */
  private savedView: BoardView | null = null;
  /** The canvas size last seen, so a resize can keep the middle of the board in the middle. */
  private screenSize = { width: 0, height: 0 };
  /** Where the canvas's left edge was in the window, so the sidebar coming or going doesn't move the board. */
  private screenLeft = 0;
  /** How much of the canvas's right side the floating inspector hides, in screen pixels. */
  private coveredRight = 0;
  private drag: Drag | null = null;
  private wheelAt = 0;
  /** Set by a press: the scroll gesture already under way is ignored until it ends, so it can't slide the board. */
  private wheelHeld = false;
  /** Space is held: a press anywhere pans the board. */
  private spaceDown = false;
  private pointerOver = false;
  private lastDown = { id: '', time: 0 };

  constructor(private events: BoardEvents) {}

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      background: BOARD_BG,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      preference: 'webgl',
    });
    if (this.destroyed) {
      this.app.destroy({ removeView: true }, { children: true });
      return;
    }
    this.ready = true;
    this.host = host;
    host.appendChild(this.app.canvas);

    this.grayscaleFilter.desaturate();
    this.selectionBox.eventMode = 'none';
    this.app.stage.addChild(this.world, this.selectionBox);
    this.rippleRings.eventMode = 'none';
    this.rippleRings.zIndex = Number.MAX_SAFE_INTEGER - 2;
    this.selectionOutline.eventMode = 'none';
    this.selectionOutline.zIndex = Number.MAX_SAFE_INTEGER - 1;
    this.scaleHandle.zIndex = Number.MAX_SAFE_INTEGER;
    this.scaleHandle.eventMode = 'static';
    this.scaleHandle.cursor = 'nwse-resize';
    this.scaleHandle.on('pointerdown', (e) => this.startScale(e));
    this.world.addChild(this.rippleRings, this.selectionOutline, this.scaleHandle);

    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e) => this.onBackgroundDown(e));
    stage.on('globalpointermove', (e) => this.onPointerMove(e));
    stage.on('pointerup', () => this.endDrag());
    stage.on('pointerupoutside', () => this.endDrag());

    this.app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.app.canvas.addEventListener('pointerenter', this.onPointerEnter);
    this.app.canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    // Space let go while another app was in front never arrives here.
    window.addEventListener('blur', this.releaseSpace);
    this.screenSize = { width: this.app.screen.width, height: this.app.screen.height };
    this.screenLeft = host.getBoundingClientRect().left;
    this.resizeObserver = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = host;
      const left = host.getBoundingClientRect().left;
      // The sidebar opening or closing moves the canvas's left edge: the board stays where it is on screen.
      // Otherwise the window was resized, and the middle of the board stays in the middle.
      const dx = left !== this.screenLeft ? this.screenLeft - left : (width - this.screenSize.width) / 2;
      this.world.position.set(this.world.x + dx, this.world.y + (height - this.screenSize.height) / 2);
      this.screenSize = { width, height };
      this.screenLeft = left;
      // Resize, move and draw in one go, before the browser paints: resized and drawn first, the board showed
      // for a frame where it was before the move.
      this.app.renderer.resize(width, height);
      this.drawSelection();
      this.app.render();
    });
    this.resizeObserver.observe(host);

    this.setGrayscale(this.grayscale);
    this.syncGroups();
    this.sync();
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.dwellTimer);
    window.clearTimeout(this.holdTimer);
    if (!this.ready) return;
    this.ready = false;
    this.resizeObserver?.disconnect();
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    this.app.canvas.removeEventListener('pointerenter', this.onPointerEnter);
    this.app.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.releaseSpace);
    this.app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
    this.textures.clear();
    this.favicons.clear();
  }

  // ---- state from React --------------------------------------------------------------

  /** `view` is where this board was left last time; it only counts when the board changes. */
  setItems(items: BoardItem[], boardId: string, view: BoardView | null = null): void {
    if (boardId !== this.boardId) {
      this.boardId = boardId;
      this.selected = [];
      this.pickedGroup = null;
      if (this.pendingReveal?.boardId !== boardId) this.pendingReveal = null;
      this.viewGlide = null;
      this.endRipple();
      this.savedView = view && [view.x, view.y, view.zoom].every(Number.isFinite) && view.zoom > 0 ? view : null;
      this.needsFit = this.savedView === null;
      for (const node of this.nodes.values()) node.root.destroy({ children: true });
      this.nodes.clear();
      this.glides.clear();
    }
    this.items = items;
    this.sync();
  }

  /** The board's groups and their titles. Which items are in each comes with the items. */
  setGroups(groups: Group[]): void {
    this.groupList = groups;
    this.syncGroups();
  }

  /** Hides a group's title while React edits it in a text field over the board; null when done. */
  editTitle(groupId: string | null): void {
    this.editingGroup = groupId;
    if (this.ready) this.drawSelection();
  }

  select(itemIds: string[], groupId: string | null = null): void {
    this.selected = [...new Set(itemIds)];
    this.pickedGroup = groupId;
    if (this.ready) this.drawSelection();
  }

  /** The inspector opened or closed over the right of the canvas. Whatever is selected moves out from under it. */
  setCoveredRight(width: number): void {
    this.coveredRight = width;
    this.keepSelectionClear();
  }

  setGrayscale(on: boolean): void {
    this.grayscale = on;
    if (!this.ready) return;
    // Value check: see the board in black and white without touching the images.
    this.app.stage.filters = on ? [this.grayscaleFilter] : [];
    this.app.stage.filterArea = on ? this.app.screen : undefined;
  }

  /**
   * A newly saved item: slide the view over until all of it is in sight, select it (unless a note is being
   * typed) and send a ripple out of it, so it can't be missed. Waits until the item is on the board.
   */
  reveal(boardId: string, itemId: string): void {
    this.pendingReveal = { boardId, itemId };
    this.revealPending();
  }

  fitAll(): void {
    if (!this.ready) return;
    this.stopViewGlide();
    this.fit();
    this.reportView();
  }

  zoomBy(factor: number): void {
    if (!this.ready) return;
    this.stopViewGlide();
    this.zoomAt({ x: this.app.screen.width / 2, y: this.app.screen.height / 2 }, this.world.scale.x * factor);
  }

  // ---- view --------------------------------------------------------------------------

  /** The point in the middle of the canvas, in board units, and the zoom. */
  private currentView(): BoardView {
    const { width, height } = this.app.screen;
    const zoom = this.world.scale.x;
    return { x: (width / 2 - this.world.x) / zoom, y: (height / 2 - this.world.y) / zoom, zoom };
  }

  private showView(view: BoardView): void {
    const { width, height } = this.app.screen;
    const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
    this.world.scale.set(zoom);
    this.world.position.set(width / 2 - view.x * zoom, height / 2 - view.y * zoom);
    this.drawSelection();
  }

  private reportView(): void {
    if (this.boardId) this.events.viewChanged(this.boardId, this.currentView());
  }

  /** The view nearest this one that shows all of `node`, clear of the edges and the floating tools. */
  private viewShowing(node: Node): BoardView {
    const { width, height } = this.app.screen;
    const p = node.data.placement;
    const w = node.w * p.scale;
    const h = node.h * p.scale;
    if (this.nodes.size === 1) return this.loneView({ x: p.x, y: p.y, width: w, height: h });
    const room = this.revealRoom();
    const zoom = clamp(Math.min(this.world.scale.x, room.w / w, room.h / h), MIN_ZOOM, MAX_ZOOM);
    // Where the board would sit at that zoom without panning, then the least panning that brings the item in.
    const view = this.currentView();
    const nudge = (start: number, size: number, low: number, high: number) =>
      start < low ? low - start : start + size > high ? high - start - size : 0;
    let x = width / 2 - view.x * zoom;
    let y = height / 2 - view.y * zoom;
    x += nudge(x + p.x * zoom, w * zoom, REVEAL_PAD.side, width - REVEAL_PAD.side - this.coveredRight);
    y += nudge(y + p.y * zoom, h * zoom, REVEAL_PAD.top, height - REVEAL_PAD.bottom);
    return { x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom, zoom };
  }

  /** The canvas left for showing things, clear of the edges, the floating tools and the inspector (screen px). */
  private revealRoom(): { w: number; h: number } {
    const { width, height } = this.app.screen;
    return {
      w: Math.max(1, width - REVEAL_PAD.side * 2 - this.coveredRight),
      h: Math.max(1, height - REVEAL_PAD.top - REVEAL_PAD.bottom),
    };
  }

  /**
   * How a board with one reference on it is shown (`item` in board units): in the middle, taking about
   * LONE_SHARE of the canvas, so it reads as a board with room for more. Never past 100%, so a small
   * picture stays its own size.
   */
  private loneView(item: ScreenRect): BoardView {
    const { width, height } = this.app.screen;
    const box = this.groupMembers().size > 0 ? groupFrame([{ id: '', x: item.x, y: item.y, w: item.width, h: item.height }]) : item;
    const room = this.revealRoom();
    const zoom = clamp(Math.min(1, (LONE_SHARE * room.w) / box.width, (LONE_SHARE * room.h) / box.height), MIN_ZOOM, MAX_ZOOM);
    // The middle of the box goes to the middle of that room, which isn't the middle of the canvas.
    const middle = { x: (width - this.coveredRight) / 2, y: (REVEAL_PAD.top + height - REVEAL_PAD.bottom) / 2 };
    return {
      x: box.x + box.width / 2 + (width / 2 - middle.x) / zoom,
      y: box.y + box.height / 2 + (height / 2 - middle.y) / zoom,
      zoom,
    };
  }

  /**
   * Slides the board left just enough that the selected item is clear of the inspector, keeping its left edge
   * in sight when it's too wide to fit beside it. Only pans: a click shouldn't change the zoom.
   */
  private keepSelectionClear(): void {
    // The inspector is about one item; with several selected it is closed.
    const node = this.selected.length === 1 ? this.nodes.get(this.selected[0]) : undefined;
    if (!this.ready || !node || !this.coveredRight || this.drag) return;
    const zoom = this.world.scale.x;
    const left = this.world.x + node.root.x * zoom;
    const right = left + node.w * node.root.scale.x * zoom;
    const clear = this.app.screen.width - this.coveredRight - REVEAL_PAD.side;
    const shift = Math.min(right - clear, left - REVEAL_PAD.side);
    if (shift <= 0) return;
    const view = this.currentView();
    this.glideView({ ...view, x: view.x + shift / zoom });
  }

  /** Slides the view to `to`, so the eye can follow where it goes. False when there is nothing to watch. */
  private glideView(to: BoardView): boolean {
    const from = this.currentView();
    const still = Math.abs(to.zoom / from.zoom - 1) < 1e-6 && Math.hypot(to.x - from.x, to.y - from.y) * from.zoom < 0.5;
    if (still) return false;
    if (reducedMotion()) {
      this.showView(to);
      this.reportView();
      return false;
    }
    this.viewGlide = { from, to, start: performance.now() };
    this.app.ticker.remove(this.stepView);
    this.app.ticker.add(this.stepView);
    return true;
  }

  private stepView = (): void => {
    const glide = this.viewGlide;
    if (!glide) return void this.app.ticker.remove(this.stepView);
    const t = Math.min(1, (performance.now() - glide.start) / REVEAL_MS);
    const k = 1 - (1 - t) ** 3; // ease out
    const { from, to } = glide;
    this.showView({
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      zoom: from.zoom * (to.zoom / from.zoom) ** k,
    });
    if (t === 1) {
      this.viewGlide = null;
      this.app.ticker.remove(this.stepView);
      this.reportView();
    }
  };

  /** The person took hold of the view: stop sliding it for them, and keep it where it got to. */
  private stopViewGlide(): void {
    if (!this.viewGlide) return;
    this.viewGlide = null;
    this.app.ticker.remove(this.stepView);
    this.reportView();
  }

  private fit(): void {
    const screen = this.app.screen;
    if (this.nodes.size === 0) {
      this.world.scale.set(1);
      this.world.position.set(screen.width / 2, screen.height / 2);
      return this.drawSelection();
    }
    let all = boundsOf([...this.nodes.values()]);
    for (const nodes of this.groupMembers().values()) all = union(all, groupFrame(boxesOf(nodes)));
    const pad = 64;
    const zoom = clamp(Math.min((screen.width - pad * 2) / all.width, (screen.height - pad * 2) / all.height), MIN_ZOOM, 1);
    this.world.scale.set(zoom);
    this.world.position.set(
      (screen.width - all.width * zoom) / 2 - all.x * zoom,
      (screen.height - all.height * zoom) / 2 - all.y * zoom,
    );
    this.drawSelection();
  }

  // ---- nodes -------------------------------------------------------------------------

  private sync(): void {
    if (!this.ready) return;
    const wanted = new Set(this.items.map((b) => b.item.id));
    for (const [id, node] of this.nodes) {
      if (!wanted.has(id)) {
        node.root.destroy({ children: true });
        this.nodes.delete(id);
      }
    }
    for (const data of this.items) {
      const node = this.nodes.get(data.item.id);
      if (!node) {
        this.nodes.set(data.item.id, this.createNode(data));
        continue;
      }
      const titleChanged = isBookmark(data.item) && data.item.title !== node.data.item.title;
      node.data = data;
      if (titleChanged) this.fillBookmark(node);
      const dragging = this.drag && 'ids' in this.drag && this.drag.ids.includes(node.id);
      if (!dragging) this.glideTo(node);
    }
    this.selected = this.selected.filter((id) => this.nodes.has(id));
    if (this.ripple && !this.nodes.has(this.ripple.id)) this.endRipple();
    if (this.savedView) {
      this.showView(this.savedView);
      this.savedView = null;
    } else if (this.needsFit && this.nodes.size > 0) {
      this.needsFit = false;
      // Fitting one reference would fill the screen with it; a first look shouldn't (LONE_SHARE).
      if (this.nodes.size === 1) this.showView(this.loneView(boundsOf([...this.nodes.values()])));
      else this.fit();
    } else if (this.needsFit) {
      this.fit();
    }
    this.drawSelection();
    this.revealPending();
  }

  private revealPending(): void {
    const want = this.pendingReveal;
    // While something is held the view isn't ours to move; the reveal waits for the hand to come off.
    if (!this.ready || !want || want.boardId !== this.boardId || this.drag) return;
    const node = this.nodes.get(want.itemId);
    if (!node) return;
    this.pendingReveal = null;
    if (!isTyping(document.activeElement)) this.setSelection([node.id]);
    const sliding = this.glideView(this.viewShowing(node));
    if (!reducedMotion()) {
      this.ripple = { id: node.id, start: performance.now() + (sliding ? REVEAL_MS : 0) };
      this.app.ticker.remove(this.stepRipple);
      this.app.ticker.add(this.stepRipple);
    }
    this.drawSelection();
    this.events.revealed(node.id);
  }

  /** Two rings swell out of the new item and fade, drawn at a steady width on screen whatever the zoom. */
  private stepRipple = (): void => {
    const ripple = this.ripple;
    const node = ripple && this.nodes.get(ripple.id);
    const elapsed = ripple ? performance.now() - ripple.start : Infinity;
    if (!node || elapsed > RIPPLE_GAP_MS + RIPPLE_MS) return this.endRipple();
    this.rippleRings.clear();
    const zoom = this.world.scale.x;
    const s = node.root.scale.x;
    for (const delay of [0, RIPPLE_GAP_MS]) {
      const t = (elapsed - delay) / RIPPLE_MS;
      if (t < 0 || t > 1) continue;
      const spread = (4 + 28 * (1 - (1 - t) ** 2)) / zoom;
      this.rippleRings
        .roundRect(node.root.x - spread, node.root.y - spread, node.w * s + spread * 2, node.h * s + spread * 2, spread)
        .stroke({ width: 3 / zoom, color: ACCENT, alpha: 1 - t });
    }
  };

  private endRipple(): void {
    this.ripple = null;
    this.rippleRings.clear();
    if (this.ready) this.app.ticker.remove(this.stepRipple);
  }

  private syncGroups(): void {
    if (!this.ready) return;
    const wanted = new Map(this.groupList.map((g) => [g.id, g]));
    for (const [id, view] of this.groups) {
      if (wanted.has(id)) continue;
      if (this.hoveredGroup === id) this.hoveredGroup = null;
      view.frame.destroy();
      view.label.destroy({ children: true });
      view.handle.destroy();
      this.groups.delete(id);
    }
    for (const group of this.groupList) {
      let view = this.groups.get(group.id);
      if (!view) {
        view = this.createGroupView(group.id);
        this.groups.set(group.id, view);
      }
      if (view.title !== group.title) {
        view.title = group.title;
        view.fittedTo = -1;
      }
    }
    this.drawSelection();
  }

  private createGroupView(id: string): GroupView {
    const frame = new Graphics();
    frame.eventMode = 'none';
    const text = new Text({
      text: '',
      resolution: 2,
      style: textStyle(GROUP_BAR.text, GROUP_BAR.line, 1000, 0xa9a9b4, '500'),
    });
    const label = new Container();
    label.eventMode = 'none';
    label.addChild(text);
    // Under the group's references like the rest of the frame, so one laid over the label still gets its own press.
    const handle = new Container();
    handle.eventMode = 'static';
    handle.on('pointerdown', (e) => this.onGroupDown(id, e));
    handle.on('pointerover', () => this.hoverGroup(id));
    handle.on('pointerout', () => this.hoveredGroup === id && this.hoverGroup(null));
    this.world.addChild(frame, label, handle);
    return { id, title: '', frame, label, handle, text, fittedTo: -1, box: null };
  }

  private hoverGroup(groupId: string | null): void {
    this.hoveredGroup = groupId;
    this.drawSelection();
  }

  /** A group's items on this board, back to front. */
  private membersOf(groupId: string): string[] {
    return (this.groupMembers().get(groupId) ?? [])
      .sort((a, b) => a.data.placement.z - b.data.placement.z)
      .map((n) => n.id);
  }

  /** Each group's items, by group id, leaving out those being dragged out of it. */
  private groupMembers(): Map<string, Node[]> {
    const members = new Map<string, Node[]>();
    for (const node of this.nodes.values()) {
      const id = node.data.placement.groupId;
      if (!id || this.leaving.has(node.id)) continue;
      const list = members.get(id);
      if (list) list.push(node);
      else members.set(id, [node]);
    }
    return members;
  }

  /**
   * Draws each group's frame around its items as they are now (mid-drag too), with its title bar on top
   * (GROUP_BAR) that lights up under the pointer, as the place to pick the group up. A group whose items
   * are all selected is outlined in the selection colour.
   */
  private drawGroups(members: Map<string, Node[]>): void {
    const zoom = this.world.scale.x;
    const selected = new Set(this.selected);
    for (const view of this.groups.values()) {
      const nodes = members.get(view.id);
      view.frame.clear();
      if (!nodes) {
        // Hidden under the pointer, its label never hears the pointer leave.
        if (this.hoveredGroup === view.id) this.hoveredGroup = null;
        view.box = null;
        view.label.visible = false;
        view.handle.visible = false;
        continue;
      }
      const boxes = boxesOf(nodes);
      const box = groupFrame(boxes);
      view.box = box;
      const bottom = Math.min(...nodes.map((n) => n.data.placement.z));
      view.frame.zIndex = bottom + GROUP_LAYER.frame;
      view.label.zIndex = bottom + GROUP_LAYER.label;
      view.handle.zIndex = bottom + GROUP_LAYER.handle;
      const whole = nodes.every((n) => selected.has(n.id));
      const wide = box.width * zoom;
      const barred = wide >= GROUP_BAR.minFrame;
      if (!barred && this.hoveredGroup === view.id) this.hoveredGroup = null;
      const hovered = view.id === this.hoveredGroup;

      // Everything is drawn in board units, so screen sizes are divided by the zoom. The bar's top corners are
      // rounded like a toolbar's; the frame's bottom ones the same, or less where the room inside is smaller.
      const { x, y, width: w } = box;
      const floor = y + box.height;
      const bar = barred ? GROUP_BAR.height / zoom : 0;
      const top = y - bar;
      const rTop = GROUP_BAR.radius / zoom;
      const rBottom = Math.min(GROUP_BAR.radius / zoom, groupPad(boxes));
      const outline = () =>
        view.frame
          .moveTo(x, top + rTop)
          .arcTo(x, top, x + rTop, top, rTop)
          .lineTo(x + w - rTop, top)
          .arcTo(x + w, top, x + w, top + rTop, rTop)
          .lineTo(x + w, floor - rBottom)
          .arcTo(x + w, floor, x + w - rBottom, floor, rBottom)
          .lineTo(x + rBottom, floor)
          .arcTo(x, floor, x, floor - rBottom, rBottom)
          .closePath();
      outline().fill({ color: 0xffffff, alpha: 0.025 });
      if (barred) {
        // Solid, so nothing it lies over shows through the title.
        view.frame
          .moveTo(x, y)
          .lineTo(x, top + rTop)
          .arcTo(x, top, x + rTop, top, rTop)
          .lineTo(x + w - rTop, top)
          .arcTo(x + w, top, x + w, top + rTop, rTop)
          .lineTo(x + w, y)
          .closePath()
          .fill({ color: hovered ? 0x212126 : 0x1a1a1e });
        view.frame.moveTo(x, y).lineTo(x + w, y).stroke({ width: 1 / zoom, color: 0x2b2b31 });
      }
      outline().stroke({ width: 1 / zoom, color: whole ? ACCENT : hovered ? 0x55555f : 0x3a3a42, alpha: whole ? 0.9 : 1 });

      // The title, at its own size on screen (scaled against the zoom), in the middle of the bar's height.
      const fill = view.title ? (hovered ? 0xececf0 : 0xa9a9b4) : hovered ? 0xa9a9b4 : 0x74747f;
      if (view.text.style.fill !== fill) view.text.style.fill = fill;
      this.fitTitle(view, wide - GROUP_BAR.inset * 2);
      view.label.scale.set(1 / zoom);
      view.label.position.set(x + GROUP_BAR.inset / zoom, top + (GROUP_BAR.height - GROUP_BAR.line) / 2 / zoom);
      view.label.visible = barred && view.id !== this.editingGroup;
      // Anywhere on the bar picks up the group.
      view.handle.scale.set(1 / zoom);
      view.handle.position.set(x, top);
      view.handle.hitArea = new Rectangle(0, 0, wide, GROUP_BAR.height);
      view.handle.visible = barred;
    }

    const editing = this.editingGroup ? this.groups.get(this.editingGroup) : undefined;
    if (!editing?.box) return this.events.titleMoved(null, 0);
    const corner = this.world.toGlobal({ x: editing.box.x, y: editing.box.y });
    this.events.titleMoved(
      {
        x: corner.x + GROUP_BAR.inset,
        y: corner.y - GROUP_BAR.height,
        width: editing.box.width * zoom - GROUP_BAR.inset * 2,
        height: GROUP_BAR.height,
      },
      GROUP_BAR.text,
    );
  }

  /** The room a group's title bar takes above its frame, in board units at the zoom now. */
  private labelRoom(): number {
    return GROUP_BAR.height / this.world.scale.x;
  }

  /**
   * The title cut to one line `width` wide (screen px), ending in "…" when it doesn't fit. Only measured
   * again when the width has changed by a few pixels, as it changes all through a zoom.
   */
  private fitTitle(view: GroupView, width: number): void {
    const w = Math.max(1, Math.floor(width / 4) * 4);
    if (w === view.fittedTo) return;
    view.fittedTo = w;
    const style = view.text.style;
    style.wordWrapWidth = w;
    view.text.text = clampLines(view.title || 'Untitled group', style, 1);
  }

  private createNode(data: BoardItem): Node {
    const { item } = data;
    const { w, h } = itemSize(item);
    const root = new Container();
    // The plain arrow over items too: no hand hinting that they can be dragged.
    root.eventMode = 'static';
    root.hitArea = new Rectangle(0, 0, w, h);
    const node: Node = { id: item.id, root, w, h, data };
    root.on('pointerdown', (e) => this.onNodeDown(node, e));
    this.applyPlacement(node);
    this.world.addChild(root);

    if (isBookmark(item)) {
      this.fillBookmark(node);
    } else if (item.asset) {
      root.addChild(new Graphics().rect(0, 0, w, h).fill(0x222228));
      this.texture(item.asset)
        .then((texture) => {
          if (root.destroyed) return;
          root.removeChildren().forEach((c) => c.destroy());
          const sprite = new Sprite(texture);
          sprite.setSize(w, h);
          root.addChild(sprite);
        })
        .catch((e) => console.warn('could not load', item.asset, e));
    }
    return node;
  }

  /**
   * A saved page, drawn as a bookmark card: its picture on top (the page's own preview
   * picture, or a screenshot of it), then its title and site. Without a picture, a text card.
   */
  private fillBookmark(node: Node): void {
    const { item } = node.data;
    const { root, w, h } = node;
    root.removeChildren().forEach((c) => c.destroy());
    const frame = new Graphics().roundRect(0, 0, w, h, BOOKMARK.radius).fill(0x1d1d23);
    root.addChild(frame.stroke({ width: 2, color: 0x34343e, alignment: 1 }));
    const title = item.title || item.source.pageTitle || siteName(item.source.pageUrl);
    const site = item.source.site || siteName(item.source.pageUrl);

    if (!(item.asset && item.width && item.height)) {
      this.siteRow(root, item.source.faviconUrl, site, 64, 64, 48);
      const heading = textStyle(64, 78, w - 128, 0xf3f3f6, '600');
      const text = new Text({ text: clampLines(title, heading, 4), style: heading, resolution: 2 });
      text.position.set(64, 152);
      const kind = new Text({
        text: ITEM_KIND_LABELS[item.kind].toUpperCase(),
        resolution: 2,
        style: { fill: 0x7c7c87, fontSize: 26, fontFamily: FONT, letterSpacing: 3, fontWeight: '600' },
      });
      kind.position.set(64, h - 64 - 26);
      root.addChild(text, kind);
      return;
    }

    const band = bookmarkPictureHeight(item.width, item.height);
    const picture = new Container();
    picture.addChild(new Graphics().rect(0, 0, w, band).fill(0x26262d));
    // Rounds the top corners only: the mask runs on under the caption.
    const mask = new Graphics().roundRect(0, 0, w, band + BOOKMARK.radius, BOOKMARK.radius).fill(0xffffff);
    picture.mask = mask;
    root.addChild(picture, mask);
    this.texture(item.asset)
      .then((texture) => {
        if (picture.destroyed) return;
        // A big picture fills the band, its edges cropped; a small one sits in the middle at up to twice its size.
        const scale = !isSmallPicture(texture.width)
          ? Math.max(w / texture.width, band / texture.height)
          : Math.min(2, (w - 160) / texture.width, (band - 160) / texture.height);
        const sprite = new Sprite(texture);
        sprite.setSize(texture.width * scale, texture.height * scale);
        sprite.position.set((w - sprite.width) / 2, (band - sprite.height) / 2);
        picture.addChild(sprite);
      })
      .catch((e) => console.warn('could not load', item.asset, e));

    const heading = textStyle(50, 62, w - 112, 0xf3f3f6, '600');
    const text = new Text({ text: clampLines(title, heading, 2), style: heading, resolution: 2 });
    text.position.set(56, band + 40);
    root.addChild(text);
    this.siteRow(root, item.source.faviconUrl, site, 56, band + 192, 44);
  }

  /** The site's icon and name. The icon is best effort: many sites don't let other apps read it. */
  private siteRow(parent: Container, favicon: string | undefined, site: string, x: number, y: number, size: number): void {
    const slot = new Container();
    slot.position.set(x, y);
    // Until the icon arrives, or when it can't: the site's first letter on a tile.
    const initial = new Text({
      text: (site.replace(/^www\./, '')[0] ?? '?').toUpperCase(),
      resolution: 2,
      style: { fill: 0xa3a3ae, fontSize: size * 0.55, fontFamily: FONT, fontWeight: '600' },
    });
    initial.anchor.set(0.5);
    initial.position.set(size / 2);
    slot.addChild(new Graphics().roundRect(0, 0, size, size, size * 0.22).fill(0x2e2e36), initial);
    const name = new Text({
      text: site,
      resolution: 2,
      style: { fill: 0x9a9aa8, fontSize: size * 0.72, fontFamily: FONT },
    });
    name.anchor.set(0, 0.5);
    name.position.set(x + size + size * 0.36, y + size / 2);
    parent.addChild(slot, name);
    if (!favicon) return;
    this.favicon(favicon).then((texture) => {
      if (!texture || slot.destroyed) return;
      const icon = new Sprite(texture);
      icon.setSize(size, size);
      const mask = new Graphics().roundRect(0, 0, size, size, size * 0.22).fill(0xffffff);
      icon.mask = mask;
      slot.removeChildren().forEach((c) => c.destroy({ children: true }));
      slot.addChild(icon, mask);
    });
  }

  private applyPlacement(node: Node): void {
    const p = node.data.placement;
    node.root.position.set(p.x, p.y);
    node.root.scale.set(p.scale);
    node.root.zIndex = p.z;
  }

  /** Like applyPlacement, but an item already on the board slides there, so a rearrangement can be followed. */
  private glideTo(node: Node): void {
    const p = node.data.placement;
    const { root } = node;
    root.zIndex = p.z;
    if (root.x === p.x && root.y === p.y && root.scale.x === p.scale) return;
    if (reducedMotion()) return this.applyPlacement(node);
    if (this.glides.size === 0) this.app.ticker.add(this.stepGlides);
    this.glides.set(node.id, { from: { x: root.x, y: root.y, scale: root.scale.x }, start: performance.now() });
  }

  private stepGlides = (): void => {
    const now = performance.now();
    for (const [id, glide] of this.glides) {
      const node = this.nodes.get(id);
      const t = Math.min(1, (now - glide.start) / GLIDE_MS);
      if (!node || t === 1) {
        this.glides.delete(id);
        if (node) this.applyPlacement(node);
        continue;
      }
      const k = 1 - (1 - t) ** 3; // ease out
      const { from } = glide;
      const p = node.data.placement;
      node.root.position.set(from.x + (p.x - from.x) * k, from.y + (p.y - from.y) * k);
      node.root.scale.set(from.scale + (p.scale - from.scale) * k);
    }
    if (this.glides.size === 0) this.app.ticker.remove(this.stepGlides);
    this.drawSelection();
  };

  /** Ends every slide at once, so an item grabbed mid-way is where it will stay. */
  private finishGlides(): void {
    for (const id of this.glides.keys()) {
      const node = this.nodes.get(id);
      if (node) this.applyPlacement(node);
    }
    this.glides.clear();
    this.app.ticker.remove(this.stepGlides);
  }

  /** A site's icon from the web, or null when the site doesn't allow reading it. */
  private favicon(url: string): Promise<Texture | null> {
    let pending = this.favicons.get(url);
    if (!pending) {
      pending = loadTexture(url).then(
        (texture) => {
          if (this.destroyed) texture.destroy(true);
          return texture;
        },
        () => null,
      );
      this.favicons.set(url, pending);
    }
    return pending;
  }

  private texture(asset: string): Promise<Texture> {
    let pending = this.textures.get(asset);
    if (!pending) {
      pending = loadTexture(assetUrl(asset)).then((texture) => {
        if (this.destroyed) texture.destroy(true);
        return texture;
      });
      this.textures.set(asset, pending);
    }
    return pending;
  }

  // ---- interaction -------------------------------------------------------------------

  private onNodeDown(node: Node, e: FederatedPointerEvent): void {
    // Space or the middle button pans from anywhere, items included; the right button is kept for a menu.
    if (e.button !== 0 || this.spaceDown) return;
    e.stopPropagation();
    this.stopViewGlide();
    this.wheelHeld = true;
    this.finishGlides();
    // Shift or ⌘ adds an item to the selection, or takes it back out.
    const toggle = e.shiftKey || e.metaKey;
    const now = performance.now();
    if (!toggle && this.lastDown.id === node.id && now - this.lastDown.time < DOUBLE_CLICK_MS) {
      this.lastDown = { id: '', time: 0 };
      this.events.openSource(node.id);
      return;
    }
    this.lastDown = toggle ? { id: '', time: 0 } : { id: node.id, time: now };

    const before = this.selected;
    const wasSelected = before.includes(node.id);
    if (toggle && wasSelected) return this.setSelection(this.selected.filter((id) => id !== node.id));
    if (toggle) this.setSelection([...this.selected, node.id]);
    // Pressing one of several selected items keeps them all, so they can be dragged together; unless they are
    // just the item's group, which its title moves: a press on one of its items arranges (or takes out) that one.
    else if (!wasSelected || this.isWholeGroupOf(node)) this.setSelection([node.id]);

    const ids = [...this.selected];
    this.drag = {
      kind: 'move',
      ids,
      pressed: node.id,
      pressedGroup: null,
      grab: this.world.toLocal(e.global),
      from: this.spotsOf(ids),
      raised: this.bringToFront(ids),
      homes: this.homeFrames(ids),
      lifted: false,
      dwellAt: null,
      holdFirst: false,
      shift: { x: 0, y: 0 },
      start: e.global.clone(),
      moved: false,
      plain: !toggle,
      fresh: this.selected !== before,
    };
    // ⌥: the other way out of a group. Held still a moment, the reference lifts; dropped outside, it leaves.
    if (e.altKey && this.drag.homes.size > 0) {
      this.drag.holdFirst = true;
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(this.liftHeld, HOLD_TO_LIFT_MS);
    }
    this.drawSelection();
  }

  /** With ⌥, the press was held still long enough: the reference lifts free of its group. */
  private liftHeld = (): void => {
    this.holdTimer = 0;
    const drag = this.drag;
    if (drag?.kind === 'move' && drag.holdFirst && !drag.lifted) this.setLifted(drag, true);
  };

  /** Whether what's selected is exactly `node`'s group, of more than it. */
  private isWholeGroupOf(node: Node): boolean {
    const groupId = node.data.placement.groupId;
    if (!groupId) return false;
    const members = this.membersOf(groupId);
    return members.length > 1 && members.length === this.selected.length && members.every((id) => this.selected.includes(id));
  }

  /**
   * Follows a drag for references carried out of their groups. Wholly outside the group's frame (as it was at the
   * press), the pointer must rest there a moment before they come out: they grow a little, and the frame lets
   * go of them. Carried back inside, they are back in the group and would have to wait outside again.
   */
  private watchDwell(drag: Extract<Drag, { kind: 'move' }>, pointer: PointData): void {
    const outside = this.outsideHomes(drag);
    if (drag.lifted) {
      this.leaving = new Set(outside);
      if (outside.length === 0) this.setLifted(drag, false);
      return;
    }
    if (outside.length === 0) {
      window.clearTimeout(this.dwellTimer);
      this.dwellTimer = 0;
      drag.dwellAt = null;
      return;
    }
    const at = drag.dwellAt;
    if (at && Math.hypot(pointer.x - at.x, pointer.y - at.y) <= DWELL_SLOP) return; // still resting
    // Just got out, or moved on: wait afresh from here.
    window.clearTimeout(this.dwellTimer);
    drag.dwellAt = { x: pointer.x, y: pointer.y };
    this.dwellTimer = window.setTimeout(this.comeOut, DWELL_TO_LEAVE_MS);
  }

  /** The pointer rested outside the group long enough: what's out there comes out of its groups. */
  private comeOut = (): void => {
    this.dwellTimer = 0;
    const drag = this.drag;
    if (drag?.kind !== 'move' || drag.lifted) return;
    const outside = this.outsideHomes(drag);
    if (outside.length === 0) return;
    this.leaving = new Set(outside);
    this.setLifted(drag, true);
  };

  /** Shows what a move carries as out of its groups (a little bigger, a grabbing hand) or back in. */
  private setLifted(drag: Extract<Drag, { kind: 'move' }>, lifted: boolean): void {
    drag.lifted = lifted;
    drag.dwellAt = null;
    if (!lifted) this.leaving.clear();
    this.host?.classList.toggle('lifting', lifted);
    this.placeDragged(drag, lifted ? LIFT_SCALE : 1);
    this.drawSelection();
  }

  /** Puts what a move carries where the pointer has taken it, drawn `lift` times its size about its centre. */
  private placeDragged(drag: Extract<Drag, { kind: 'move' }>, lift: number): void {
    for (const [id, from] of drag.from) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const grow = from.scale * (lift - 1);
      node.root.scale.set(from.scale * lift);
      node.root.position.set(from.x + drag.shift.x - (node.w * grow) / 2, from.y + drag.shift.y - (node.h * grow) / 2);
    }
  }

  /**
   * A press on a group's title picks up the whole group: it selects the group's items (Shift or ⌘ adds them
   * to the selection, or takes them back out when they are all in it) and dragging moves them together. A
   * double-click renames the group.
   */
  private onGroupDown(groupId: string, e: FederatedPointerEvent): void {
    if (e.button !== 0 || this.spaceDown) return; // pans, as on an item
    e.stopPropagation();
    this.stopViewGlide();
    this.wheelHeld = true;
    this.finishGlides();
    const adding = e.shiftKey || e.metaKey;
    const now = performance.now();
    const key = `group:${groupId}`;
    if (!adding && this.lastDown.id === key && now - this.lastDown.time < DOUBLE_CLICK_MS) {
      this.lastDown = { id: '', time: 0 };
      this.events.renameGroup(groupId);
      return;
    }
    this.lastDown = adding ? { id: '', time: 0 } : { id: key, time: now };
    const members = this.membersOf(groupId);
    if (members.length === 0) return;
    const before = this.selected;
    // Shift or ⌘ on a group that is all selected takes it back out, as on an item.
    if (adding && members.every((id) => this.selected.includes(id))) {
      return this.setSelection(this.selected.filter((id) => !members.includes(id)));
    }
    if (adding) {
      const next = [...this.selected, ...members.filter((id) => !this.selected.includes(id))];
      this.setSelection(next, next.length === members.length ? groupId : null);
    }
    // Pressing a group that is already selected, alone or with more, keeps it all, so it can be dragged together.
    else if (!members.every((id) => this.selected.includes(id))) this.setSelection(members, groupId);
    const ids = [...this.selected];
    this.drag = {
      kind: 'move',
      ids,
      pressed: '',
      pressedGroup: groupId,
      grab: this.world.toLocal(e.global),
      from: this.spotsOf(ids),
      raised: this.bringToFront(ids),
      homes: this.homeFrames(ids),
      lifted: false,
      dwellAt: null,
      holdFirst: false,
      shift: { x: 0, y: 0 },
      start: e.global.clone(),
      moved: false,
      plain: !adding,
      fresh: this.selected !== before,
    };
    this.drawSelection();
  }

  private startScale(e: FederatedPointerEvent): void {
    const nodes = this.selectedNodes();
    if (e.button !== 0 || this.spaceDown || nodes.length === 0) return;
    e.stopPropagation();
    this.stopViewGlide();
    this.wheelHeld = true;
    this.finishGlides();
    // Everything selected grows or shrinks together, away from the top-left corner of the lot.
    const box = boundsOf(nodes);
    const pointer = this.world.toLocal(e.global);
    const ids = nodes.map((n) => n.id);
    this.drag = {
      kind: 'scale',
      ids,
      anchor: { x: box.x, y: box.y },
      startDistance: Math.hypot(pointer.x - box.x, pointer.y - box.y),
      from: this.spotsOf(ids),
      minFactor: Math.max(...nodes.map((n) => MIN_ITEM_SCALE / n.root.scale.x)),
    };
  }

  private onBackgroundDown(e: FederatedPointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return; // the right button is kept for a menu
    this.stopViewGlide();
    this.wheelHeld = true;
    if (e.button === 1 || this.spaceDown) {
      this.drag = { kind: 'pan', start: e.global.clone(), startPos: this.world.position.clone(), moved: false };
      this.host?.classList.add('panning');
      return;
    }
    // A plain press on the background starts the selection over; with Shift or ⌘ the box adds to it.
    const adding = e.shiftKey || e.metaKey;
    if (!adding) this.setSelection([]);
    this.drag = {
      kind: 'select',
      origin: this.world.toLocal(e.global),
      start: e.global.clone(),
      kept: adding ? [...this.selected] : [],
      moved: false,
    };
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    // The button came up somewhere we never heard about: don't let the item follow a released pointer.
    if (e.buttons === 0) return this.endDrag();
    if (drag.kind !== 'scale' && !drag.moved) {
      if (Math.hypot(e.global.x - drag.start.x, e.global.y - drag.start.y) < DRAG_THRESHOLD) return;
      drag.moved = true;
      this.drawSelection(); // now held
    }
    // With ⌥, carried off before the hold was up: a plain drag. A small wobble while holding isn't.
    if (this.holdTimer && drag.kind === 'move' && Math.hypot(e.global.x - drag.start.x, e.global.y - drag.start.y) > HOLD_SLOP) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = 0;
    }
    if (drag.kind === 'pan') {
      this.world.position.set(drag.startPos.x + e.global.x - drag.start.x, drag.startPos.y + e.global.y - drag.start.y);
      return this.drawSelection();
    }
    const pointer = this.world.toLocal(e.global);
    if (drag.kind === 'select') return this.pullSelectionBox(drag, pointer, e.global);
    if (drag.kind === 'move') {
      drag.shift = { x: pointer.x - drag.grab.x, y: pointer.y - drag.grab.y };
      this.placeDragged(drag, drag.lifted ? LIFT_SCALE : 1);
      if (!drag.holdFirst) this.watchDwell(drag, e.global);
      // Lifted by holding, it stays lifted wherever it goes: let go outside the group, it leaves; inside, it stays.
      else if (drag.lifted) this.leaving = new Set(this.outsideHomes(drag));
    } else {
      const { anchor } = drag;
      const distance = Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y);
      const k = Math.max(drag.minFactor, distance / Math.max(1, drag.startDistance));
      for (const [id, from] of drag.from) {
        const root = this.nodes.get(id)?.root;
        if (!root) continue;
        root.position.set(anchor.x + (from.x - anchor.x) * k, anchor.y + (from.y - anchor.y) * k);
        root.scale.set(from.scale * k);
      }
    }
    this.drawSelection();
  }

  /** Selects whatever the box from the press to `corner` touches, along with what was kept, and draws the box. */
  private pullSelectionBox(drag: Extract<Drag, { kind: 'select' }>, corner: PointData, screenCorner: PointData): void {
    const box = boxBetween(drag.origin, corner);
    const touched = [...this.nodes.values()]
      .filter((n) => !drag.kept.includes(n.id) && overlaps(boundsOf([n]), box))
      .sort((a, b) => a.data.placement.z - b.data.placement.z)
      .map((n) => n.id);
    this.setSelection([...drag.kept, ...touched]);
    const screenBox = boxBetween(this.world.toGlobal(drag.origin), screenCorner);
    this.selectionBox
      .clear()
      .rect(screenBox.x, screenBox.y, screenBox.width, screenBox.height)
      .fill({ color: ACCENT, alpha: 0.12 })
      .stroke({ width: 1, color: ACCENT, alpha: 0.9, alignment: 1 });
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    window.clearTimeout(this.dwellTimer);
    window.clearTimeout(this.holdTimer);
    this.dwellTimer = 0;
    this.holdTimer = 0;
    this.host?.classList.remove('panning', 'lifting');
    // Set back down at its own size before it's saved.
    if (drag?.kind === 'move' && drag.lifted) this.placeDragged(drag, 1);
    if (drag?.kind === 'pan') {
      // A middle click doesn't pan; only a real pan is a new view.
      if (!this.world.position.equals(drag.startPos)) this.reportView();
    } else if (drag?.kind === 'select') {
      this.selectionBox.clear();
    } else if (drag) {
      this.keepDragged(drag);
      // Held with ⌥ until it lifted and let go without moving, it's neither a click nor a move.
      if (drag.kind === 'move' && !drag.moved && drag.plain && !drag.lifted) {
        if (drag.pressedGroup) {
          this.setSelection(this.membersOf(drag.pressedGroup), drag.pressedGroup);
        } else {
          this.setSelection([drag.pressed]);
          this.events.clicked(drag.pressed);
          this.keepSelectionClear();
        }
      }
    }
    this.drawSelection(); // no longer held
    this.revealPending();
  }

  /**
   * For each group only some of whose references are among `ids`, its whole frame as it is now. It stays put
   * for the drag: a reference must clear the group as it was to come out, however small the rest of it is.
   */
  private homeFrames(ids: string[]): Map<string, ScreenRect> {
    const moving = new Set(ids);
    const homes = new Map<string, ScreenRect>();
    for (const [groupId, nodes] of this.groupMembers()) {
      const staying = nodes.filter((n) => !moving.has(n.id));
      if (staying.length < nodes.length && staying.length > 0) homes.set(groupId, groupFrame(boxesOf(nodes)));
    }
    return homes;
  }

  /** Which moving references are now wholly outside their group's frame as it was at the press. */
  private outsideHomes(drag: Extract<Drag, { kind: 'move' }>): string[] {
    return drag.ids.filter((id) => {
      const node = this.nodes.get(id);
      const groupId = node?.data.placement.groupId;
      const home = groupId ? drag.homes.get(groupId) : undefined;
      return !!node && !!home && !overlaps(boundsOf([node]), home);
    });
  }

  /** Saves where a drag left things, and the new stacking order of whatever the press brought to the front. */
  private keepDragged(drag: Extract<Drag, { kind: 'move' | 'scale' }>): void {
    const raised = drag.kind === 'move' ? drag.raised : [];
    const updates: LayoutUpdate[] = [];
    // What the press raised counts too: a hold can leave some of it behind, raised but no longer moving.
    for (const id of new Set([...drag.ids, ...raised])) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const p = node.data.placement;
      const { x, y } = node.root;
      const scale = node.root.scale.x;
      if (x === p.x && y === p.y && scale === p.scale && !raised.includes(id)) continue;
      p.x = x;
      p.y = y;
      p.scale = scale;
      updates.push({ itemId: id, x, y, scale, z: p.z });
    }
    const leaving = [...this.leaving];
    this.leaving.clear();
    if (leaving.length > 0) {
      this.events.leftGroups(updates, leaving);
      // Out of the group here at once (after React has read which groups they were in), so its frame doesn't
      // reach for them again until the board reloads.
      for (const id of leaving) {
        const node = this.nodes.get(id);
        if (node) node.data.placement.groupId = null;
      }
    } else if (updates.length > 0) this.events.layoutChanged(updates);
  }

  /** Changes what is selected and tells React; nothing happens when it is the same as before. */
  private setSelection(ids: string[], groupId: string | null = null): void {
    const same = ids.length === this.selected.length && ids.every((id, i) => id === this.selected[i]);
    if (same && groupId === this.pickedGroup) return;
    this.selected = ids;
    this.pickedGroup = groupId;
    this.events.select(ids, groupId);
    this.drawSelection();
  }

  private selectedNodes(): Node[] {
    return this.selected.flatMap((id) => this.nodes.get(id) ?? []);
  }

  private spotsOf(ids: string[]): Map<string, Spot> {
    const spots = new Map<string, Spot>();
    for (const id of ids) {
      const root = this.nodes.get(id)?.root;
      if (root) spots.set(id, { x: root.x, y: root.y, scale: root.scale.x });
    }
    return spots;
  }

  /**
   * Brings `ids` in front of everything else, keeping their order among themselves. Returns the ones it moved
   * in the stack; none when they are in front already.
   */
  private bringToFront(ids: string[]): string[] {
    const chosen = new Set(ids);
    let behind = 0;
    for (const n of this.nodes.values()) if (!chosen.has(n.id)) behind = Math.max(behind, n.data.placement.z);
    const lifted = ids.flatMap((id) => this.nodes.get(id) ?? []).sort((a, b) => a.data.placement.z - b.data.placement.z);
    if (lifted.every((n) => n.data.placement.z > behind)) return [];
    lifted.forEach((n, i) => {
      n.data.placement.z = behind + 1 + i;
      n.root.zIndex = n.data.placement.z;
    });
    return lifted.map((n) => n.id);
  }

  /** Trackpad: two-finger scroll pans, pinch zooms. Mouse: ⌘ + wheel zooms. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const now = performance.now();
    const sameGesture = now - this.wheelAt < WHEEL_GESTURE_GAP_MS;
    this.wheelAt = now;
    // While something is held, or while the scroll that was going on at the press is still gliding, the
    // board stays put; otherwise a click can move both the item and the view.
    if (this.drag || (this.wheelHeld && sameGesture)) return;
    this.wheelHeld = false;
    this.stopViewGlide();
    const rect = this.app.canvas.getBoundingClientRect();
    const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (e.ctrlKey || e.metaKey) {
      const speed = e.ctrlKey ? 0.012 : 0.002; // pinch gestures arrive as small ctrl+wheel deltas
      this.zoomAt(at, this.world.scale.x * Math.exp(-e.deltaY * speed));
    } else {
      this.world.position.set(this.world.x - e.deltaX, this.world.y - e.deltaY);
      this.drawSelection();
      this.reportView();
    }
  };

  /**
   * Space held over the board makes a press pan instead, wherever it lands, as in most drawing apps. Only over
   * the board: elsewhere Space still presses the focused button.
   */
  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' || isTyping(e.target)) return;
    if (e.type === 'keyup') {
      if (!this.spaceDown) return;
      e.preventDefault();
      return this.releaseSpace();
    }
    if (!this.pointerOver && !this.spaceDown) return;
    // A button clicked a moment ago still has the focus, and would be pressed too.
    e.preventDefault();
    // A handled key press makes the Mac webview hide the pointer until the mouse moves, and holding Space
    // repeats the press. Once this press is done with, show the pointer (now the hand) again.
    setTimeout(() => void api.showPointer().catch(() => undefined));
    this.spaceDown = true;
    this.host?.classList.add('pan-ready');
  };

  private releaseSpace = (): void => {
    this.spaceDown = false;
    this.host?.classList.remove('pan-ready');
  };

  private onPointerEnter = (): void => {
    this.pointerOver = true;
  };

  private onPointerLeave = (): void => {
    this.pointerOver = false;
  };

  private zoomAt(at: PointData, zoom: number): void {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const anchor = this.world.toLocal(at);
    this.world.scale.set(z);
    this.world.position.set(at.x - anchor.x * z, at.y - anchor.y * z);
    this.drawSelection();
    this.reportView();
  }

  /**
   * Draws the groups, then outlines each selected item. Several selected also get a box around them all,
   * reaching round the frames of groups that are wholly selected; a selection that is exactly one group
   * has its frame for that box. The handle that scales the selection sits on the bottom-right corner.
   */
  private drawSelection(): void {
    if (!this.ready) return;
    const members = this.groupMembers();
    this.drawGroups(members);
    const nodes = this.selectedNodes();
    this.selectionOutline.clear();
    this.scaleHandle.clear();
    if (nodes.length === 0) {
      this.scaleHandle.visible = false;
      this.events.selectionMoved(null, false);
      return;
    }
    const zoom = this.world.scale.x;
    let box = boundsOf(nodes);
    let oneGroup = false;
    // A group of one picked by its title is the group too: the box (and the tools above it) take in its frame.
    if (nodes.length > 1 || this.pickedGroup) {
      const selected = new Set(this.selected);
      for (const [id, groupNodes] of members) {
        if (!groupNodes.every((n) => selected.has(n.id))) continue;
        // The frame and its label above it, so the tools over the selection don't cover the title.
        const frame = this.groups.get(id)?.box ?? groupFrame(boxesOf(groupNodes));
        box = union(box, { ...frame, y: frame.y - this.labelRoom(), height: frame.height + this.labelRoom() });
        oneGroup = groupNodes.length === nodes.length;
      }
    }
    // Outlined even when the selection is one group: its frame can reach round references that aren't in it.
    for (const n of nodes) {
      const s = n.root.scale.x;
      this.selectionOutline.rect(n.root.x, n.root.y, n.w * s, n.h * s).stroke({ width: 2 / zoom, color: ACCENT, alignment: 1 });
    }
    if (nodes.length > 1 && !oneGroup) {
      const pad = GROUP_PAD / zoom;
      box = { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
      this.selectionOutline
        .rect(box.x, box.y, box.width, box.height)
        .stroke({ width: 1 / zoom, color: ACCENT, alpha: 0.6, alignment: 1 });
    }
    const size = 12 / zoom;
    this.scaleHandle
      .rect(-size / 2, -size / 2, size, size)
      .fill(0xffffff)
      .stroke({ width: 1.5 / zoom, color: ACCENT });
    this.scaleHandle.position.set(box.x + box.width, box.y + box.height);
    this.scaleHandle.visible = true;

    const topLeft = this.world.toGlobal({ x: box.x, y: box.y });
    const bottomRight = this.world.toGlobal({ x: box.x + box.width, y: box.y + box.height });
    const drag = this.drag;
    const held =
      !!drag &&
      drag.kind !== 'pan' &&
      (drag.kind === 'scale' || drag.moved || (drag.kind === 'move' && (drag.fresh || drag.lifted)));
    this.events.selectionMoved(
      { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y },
      held,
    );
  }
}

/** The smallest box, in board units, around all of `nodes` where they are drawn now. */
function boundsOf(nodes: Node[]): ScreenRect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const s = n.root.scale.x;
    minX = Math.min(minX, n.root.x);
    minY = Math.min(minY, n.root.y);
    maxX = Math.max(maxX, n.root.x + n.w * s);
    maxY = Math.max(maxY, n.root.y + n.h * s);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Each node's box where it is drawn now, in board units. */
function boxesOf(nodes: Node[]): Box[] {
  return nodes.map((n) => ({ id: n.id, x: n.root.x, y: n.root.y, w: n.w * n.root.scale.x, h: n.h * n.root.scale.x }));
}

/** The room inside a group's frame around `members` (board units): see GROUP_PAD_SHARE. */
export function groupPad(members: Box[]): number {
  return median(members.map((b) => Math.min(b.w, b.h))) * GROUP_PAD_SHARE;
}

/** A group's frame around `members`, in board units: the box they fill and the same room on every side. */
export function groupFrame(members: Box[]): ScreenRect {
  const pad = groupPad(members);
  const x = Math.min(...members.map((b) => b.x)) - pad;
  const y = Math.min(...members.map((b) => b.y)) - pad;
  return {
    x,
    y,
    width: Math.max(...members.map((b) => b.x + b.w)) + pad - x,
    height: Math.max(...members.map((b) => b.y + b.h)) + pad - y,
  };
}

/** The room a group takes when the app lays things out: its frame, and room above it for its label. */
export function groupFootprint(members: Box[]): ScreenRect {
  const frame = groupFrame(members);
  const room = median(members.map((b) => Math.min(b.w, b.h))) * GROUP_LABEL_ROOM_SHARE;
  return { ...frame, y: frame.y - room, height: frame.height + room };
}

function union(a: ScreenRect, b: ScreenRect): ScreenRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function boxBetween(a: PointData, b: PointData): ScreenRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function loadTexture(url: string): Promise<Texture> {
  const blob = await (await fetch(url)).blob();
  let resource: ImageBitmap | HTMLImageElement;
  try {
    resource = await createImageBitmap(blob);
  } catch {
    // SVG blobs cannot become ImageBitmaps; decode them through an <img> instead.
    resource = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = objectUrl;
    });
  }
  // Mipmaps keep big images crisp instead of shimmering when the board is zoomed out.
  const source = new ImageSource({ resource, autoGenerateMipmaps: true, scaleMode: 'linear' });
  return new Texture({ source });
}

/** An item's size on the board before its placement's scale: a picture's own size, or a bookmark card's. */
export function itemSize(item: Item): { w: number; h: number } {
  const picture = item.asset && item.width && item.height ? { w: item.width, h: item.height } : null;
  if (picture && !isBookmark(item)) return picture;
  if (!picture) return { w: BOOKMARK.w, h: BOOKMARK.textOnly };
  return { w: BOOKMARK.w, h: bookmarkPictureHeight(picture.w, picture.h) + BOOKMARK.caption };
}

/** A saved page (an article or an artist's page), as opposed to a picture saved from one. */
export function isBookmark(item: Item): boolean {
  return item.kind === 'article' || item.kind === 'artist';
}

/**
 * How tall a bookmark's picture is drawn, for a picture `width`×`height`: its own shape, kept between
 * 2:1 and 4:5, at the card's width. A small picture gets a fixed band. Must match library.rs.
 */
export function bookmarkPictureHeight(width: number, height: number): number {
  return isSmallPicture(width) ? BOOKMARK.band : BOOKMARK.w * clamp(height / width, 0.5, 1.25);
}

/** A site's icon or a profile photo rather than a preview picture: shown small, never stretched to fill. */
export function isSmallPicture(width: number): boolean {
  return width < BOOKMARK.smallPicture;
}

/** Wrapping text `width` wide; long words break, so a URL-like title can't run off the card. */
function textStyle(size: number, lineHeight: number, width: number, fill: number, weight: TextStyle['fontWeight']): TextStyle {
  return new TextStyle({
    fill,
    fontSize: size,
    lineHeight,
    fontWeight: weight,
    fontFamily: FONT,
    wordWrap: true,
    breakWords: true,
    wordWrapWidth: width,
  });
}

/** `text` cut to at most `lines` lines in `style`, ending in "…" when cut (at a space when there is one near). */
function clampLines(text: string, style: TextStyle, lines: number): string {
  const fits = (candidate: string) => CanvasTextMetrics.measureText(candidate, style).lines.length <= lines;
  if (fits(text)) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${chars.slice(0, mid).join('').trimEnd()}…`)) lo = mid;
    else hi = mid - 1;
  }
  const cut = chars.slice(0, lo).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > cut.length * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
  );
}
