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
import { assetUrl, type BoardItem, type BoardView, type Item, type LayoutUpdate } from '../api';

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
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const MIN_ITEM_SCALE = 0.05;
const DOUBLE_CLICK_MS = 350;
/** How far (screen px) the pointer travels before a press becomes a drag, so a click never nudges anything. */
const DRAG_THRESHOLD = 4;
/** Wheel events closer together than this belong to one gesture, including a trackpad's glide after the fingers lift. */
const WHEEL_GESTURE_GAP_MS = 150;
const ACCENT = 0x8fb3ff;
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoardEvents {
  select(itemId: string | null): void;
  layoutChanged(updates: LayoutUpdate[]): void;
  openSource(itemId: string): void;
  /** Where the selected item is on screen, so React can float its source badge there. */
  selectionMoved(rect: ScreenRect | null): void;
  /** The person panned, zoomed or fitted the board. Not called for the automatic fit of a board's first visit. */
  viewChanged(boardId: string, view: BoardView): void;
  /** A newly saved item asked for with `reveal` is now on screen. */
  revealed(itemId: string): void;
}

interface Node {
  id: string;
  root: Container;
  /** Size in world units before the placement's scale. */
  w: number;
  h: number;
  data: BoardItem;
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

type Drag =
  | { kind: 'move'; id: string; grab: PointData; start: PointData; moved: boolean }
  | { kind: 'scale'; id: string; startScale: number; startDistance: number }
  | { kind: 'pan'; start: PointData; startPos: PointData; moved: boolean };

/**
 * An infinite canvas rendered with PixiJS (WebGL), so large boards of big images
 * stay smooth. React owns the data; this class owns the view and reports layout edits back.
 */
export class Board {
  private app = new Application();
  private world = new Container({ sortableChildren: true });
  private selectionOutline = new Graphics();
  private rippleRings = new Graphics();
  private scaleHandle = new Graphics();
  private grayscaleFilter = new ColorMatrixFilter();
  private nodes = new Map<string, Node>();
  private glides = new Map<string, Glide>();
  private viewGlide: ViewGlide | null = null;
  /** A newly saved item to bring into view as soon as it is on this board. */
  private pendingReveal: { boardId: string; itemId: string } | null = null;
  private ripple: { id: string; start: number } | null = null;
  private textures = new Map<string, Promise<Texture>>();
  private favicons = new Map<string, Promise<Texture | null>>();
  private resizeObserver?: ResizeObserver;

  private ready = false;
  private destroyed = false;
  private boardId: string | null = null;
  private items: BoardItem[] = [];
  private selectedId: string | null = null;
  private grayscale = false;
  private needsFit = true;
  /** The view to restore once the canvas is ready: where this board was left last time. */
  private savedView: BoardView | null = null;
  /** The canvas size last seen, so a resize can keep the middle of the board in the middle. */
  private screenSize = { width: 0, height: 0 };
  private drag: Drag | null = null;
  private wheelAt = 0;
  /** Set by a press: the scroll gesture already under way is ignored until it ends, so it can't slide the board. */
  private wheelHeld = false;
  private spaceDown = false;
  private lastDown = { id: '', time: 0 };

  constructor(private events: BoardEvents) {}

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: host,
      background: '#141417',
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
    host.appendChild(this.app.canvas);

    this.grayscaleFilter.desaturate();
    this.app.stage.addChild(this.world);
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
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    this.screenSize = { width: this.app.screen.width, height: this.app.screen.height };
    this.resizeObserver = new ResizeObserver(() => {
      this.app.resize();
      const { width, height } = this.app.screen;
      this.world.position.set(
        this.world.x + (width - this.screenSize.width) / 2,
        this.world.y + (height - this.screenSize.height) / 2,
      );
      this.screenSize = { width, height };
      this.drawSelection();
    });
    this.resizeObserver.observe(host);

    this.setGrayscale(this.grayscale);
    this.sync();
  }

  destroy(): void {
    this.destroyed = true;
    if (!this.ready) return;
    this.ready = false;
    this.resizeObserver?.disconnect();
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    this.app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
    this.textures.clear();
    this.favicons.clear();
  }

  // ---- state from React --------------------------------------------------------------

  /** `view` is where this board was left last time; it only counts when the board changes. */
  setItems(items: BoardItem[], boardId: string, view: BoardView | null = null): void {
    if (boardId !== this.boardId) {
      this.boardId = boardId;
      this.selectedId = null;
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

  select(itemId: string | null): void {
    this.selectedId = itemId;
    if (this.ready) this.drawSelection();
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
    const room = { w: width - REVEAL_PAD.side * 2, h: height - REVEAL_PAD.top - REVEAL_PAD.bottom };
    const zoom = clamp(Math.min(this.world.scale.x, Math.max(1, room.w) / w, Math.max(1, room.h) / h), MIN_ZOOM, MAX_ZOOM);
    // Where the board would sit at that zoom without panning, then the least panning that brings the item in.
    const view = this.currentView();
    const nudge = (start: number, size: number, low: number, high: number) =>
      start < low ? low - start : start + size > high ? high - start - size : 0;
    let x = width / 2 - view.x * zoom;
    let y = height / 2 - view.y * zoom;
    x += nudge(x + p.x * zoom, w * zoom, REVEAL_PAD.side, width - REVEAL_PAD.side);
    y += nudge(y + p.y * zoom, h * zoom, REVEAL_PAD.top, height - REVEAL_PAD.bottom);
    return { x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom, zoom };
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes.values()) {
      const s = n.root.scale.x;
      minX = Math.min(minX, n.root.x);
      minY = Math.min(minY, n.root.y);
      maxX = Math.max(maxX, n.root.x + n.w * s);
      maxY = Math.max(maxY, n.root.y + n.h * s);
    }
    const pad = 64;
    const zoom = clamp(
      Math.min((screen.width - pad * 2) / (maxX - minX), (screen.height - pad * 2) / (maxY - minY)),
      MIN_ZOOM,
      1,
    );
    this.world.scale.set(zoom);
    this.world.position.set(
      (screen.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      (screen.height - (maxY - minY) * zoom) / 2 - minY * zoom,
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
      const dragging = this.drag && 'id' in this.drag && this.drag.id === node.id;
      if (!dragging) this.glideTo(node);
    }
    if (this.selectedId && !this.nodes.has(this.selectedId)) this.selectedId = null;
    if (this.ripple && !this.nodes.has(this.ripple.id)) this.endRipple();
    if (this.savedView) {
      this.showView(this.savedView);
      this.savedView = null;
    } else if (this.needsFit && this.nodes.size > 0) {
      this.needsFit = false;
      this.fit();
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
    if (!isTyping(document.activeElement)) {
      this.selectedId = node.id;
      this.events.select(node.id);
    }
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

  private createNode(data: BoardItem): Node {
    const { item } = data;
    const { w, h } = itemSize(item);
    const root = new Container();
    root.eventMode = 'static';
    root.cursor = 'grab';
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
    if (e.button === 1 || this.spaceDown) return; // let the stage pan
    e.stopPropagation();
    this.stopViewGlide();
    this.wheelHeld = true;
    this.finishGlides();
    const now = performance.now();
    if (this.lastDown.id === node.id && now - this.lastDown.time < DOUBLE_CLICK_MS) {
      this.lastDown = { id: '', time: 0 };
      this.events.openSource(node.id);
      return;
    }
    this.lastDown = { id: node.id, time: now };

    this.selectedId = node.id;
    this.events.select(node.id);
    const topZ = Math.max(0, ...[...this.nodes.values()].map((n) => n.data.placement.z));
    if (node.data.placement.z < topZ) node.data.placement.z = topZ + 1;
    node.root.zIndex = node.data.placement.z;

    const pointer = this.world.toLocal(e.global);
    this.drag = {
      kind: 'move',
      id: node.id,
      grab: { x: pointer.x - node.root.x, y: pointer.y - node.root.y },
      start: e.global.clone(),
      moved: false,
    };
    node.root.cursor = 'grabbing';
    this.drawSelection();
  }

  private startScale(e: FederatedPointerEvent): void {
    const node = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    if (!node) return;
    e.stopPropagation();
    this.stopViewGlide();
    this.wheelHeld = true;
    this.finishGlides();
    const pointer = this.world.toLocal(e.global);
    this.drag = {
      kind: 'scale',
      id: node.id,
      startScale: node.root.scale.x,
      startDistance: Math.hypot(pointer.x - node.root.x, pointer.y - node.root.y),
    };
  }

  private onBackgroundDown(e: FederatedPointerEvent): void {
    this.stopViewGlide();
    if (e.button === 0 && !this.spaceDown && this.selectedId) {
      this.selectedId = null;
      this.events.select(null);
      this.drawSelection();
    }
    this.wheelHeld = true;
    this.drag = { kind: 'pan', start: e.global.clone(), startPos: this.world.position.clone(), moved: false };
    this.app.canvas.style.cursor = 'grabbing';
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    // The button came up somewhere we never heard about: don't let the item follow a released pointer.
    if (e.buttons === 0) return this.endDrag();
    if (drag.kind !== 'scale' && !drag.moved) {
      if (Math.hypot(e.global.x - drag.start.x, e.global.y - drag.start.y) < DRAG_THRESHOLD) return;
      drag.moved = true;
    }
    if (drag.kind === 'pan') {
      this.world.position.set(drag.startPos.x + e.global.x - drag.start.x, drag.startPos.y + e.global.y - drag.start.y);
      return this.drawSelection();
    }
    const node = this.nodes.get(drag.id);
    if (!node) return;
    const pointer = this.world.toLocal(e.global);
    if (drag.kind === 'move') {
      node.root.position.set(pointer.x - drag.grab.x, pointer.y - drag.grab.y);
    } else {
      const distance = Math.hypot(pointer.x - node.root.x, pointer.y - node.root.y);
      node.root.scale.set(Math.max(MIN_ITEM_SCALE, (drag.startScale * distance) / Math.max(1, drag.startDistance)));
    }
    this.drawSelection();
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    this.app.canvas.style.cursor = '';
    if (drag?.kind === 'pan') {
      // A click on the background deselects without panning; only a real pan is a new view.
      if (!this.world.position.equals(drag.startPos)) this.reportView();
    } else if (drag) {
      this.keepDragged(drag.id);
    }
    this.revealPending();
  }

  private keepDragged(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.root.cursor = 'grab';
    const p = node.data.placement;
    p.x = node.root.x;
    p.y = node.root.y;
    p.scale = node.root.scale.x;
    this.events.layoutChanged([{ itemId: node.id, x: p.x, y: p.y, scale: p.scale, z: p.z }]);
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

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' || isTyping(e.target)) return;
    this.spaceDown = e.type === 'keydown';
    this.app.canvas.style.cursor = this.spaceDown ? 'grab' : '';
    if (this.spaceDown) e.preventDefault();
  };

  private zoomAt(at: PointData, zoom: number): void {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const anchor = this.world.toLocal(at);
    this.world.scale.set(z);
    this.world.position.set(at.x - anchor.x * z, at.y - anchor.y * z);
    this.drawSelection();
    this.reportView();
  }

  private drawSelection(): void {
    if (!this.ready) return;
    const node = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    this.selectionOutline.clear();
    this.scaleHandle.clear();
    if (!node) {
      this.scaleHandle.visible = false;
      this.events.selectionMoved(null);
      return;
    }
    const zoom = this.world.scale.x;
    const s = node.root.scale.x;
    const { x, y } = node.root;
    const w = node.w * s;
    const h = node.h * s;
    this.selectionOutline.rect(x, y, w, h).stroke({ width: 2 / zoom, color: ACCENT, alignment: 1 });
    const size = 12 / zoom;
    this.scaleHandle
      .rect(-size / 2, -size / 2, size, size)
      .fill(0xffffff)
      .stroke({ width: 1.5 / zoom, color: ACCENT });
    this.scaleHandle.position.set(x + w, y + h);
    this.scaleHandle.visible = true;

    const topLeft = this.world.toGlobal({ x, y });
    const bottomRight = this.world.toGlobal({ x: x + w, y: y + h });
    this.events.selectionMoved({
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    });
  }
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
