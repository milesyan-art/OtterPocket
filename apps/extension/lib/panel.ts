import { VAULT_ID, formatTimestamp, type CollectionSummary } from '@otterpocket/shared';
import { ask, type Draft, type Rect, type SaveResponse, type StatusResponse } from './messages';
import { resolveTarget, visibleRect, type Point, type Target } from './page';
import { ICONS, el, icon } from './ui';

/** Every capture UI lives in one of these; the floating button stays out of the way while one is open. */
export const CAPTURE_TAG = 'otter-pocket-capture';
/** More places to save than fit at a glance: show a filter above the list. */
const FILTER_AFTER = 8;

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: Inter, -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.panel {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 320px; max-height: calc(100vh - 32px);
  display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding: 12px; border-radius: 14px;
  background: #1a1a1e; color: #ececf0; border: 1px solid #3a3a42; box-shadow: 0 18px 50px rgba(0,0,0,.45);
  font-size: 13px; line-height: 1.45; animation: in 140ms ease-out;
}
@keyframes in { from { opacity: 0; transform: translateY(-6px); } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
header { display: flex; align-items: center; gap: 8px; }
header b { flex: 1; font-size: 13px; font-weight: 600; }
.mark { width: 16px; height: 16px; color: #8fb3ff; }
.close { width: 24px; height: 24px; border-radius: 6px; color: #a9a9b4; font-size: 16px; line-height: 24px; text-align: center; }
.close:hover { background: #2b2b31; color: #fff; }
.close:focus-visible { outline: 2px solid #8fb3ff; outline-offset: 1px; }
.preview { display: block; flex: none; width: 100%; max-height: 168px; object-fit: contain; border-radius: 9px; background: #0f0f12; }
.source { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -4px; color: #74747f; font-size: 12px; }
.source span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.source img { width: 14px; height: 14px; border-radius: 3px; flex: none; }
.card { display: grid; gap: 6px; padding: 12px; border-radius: 9px; background: #0f0f12; }
.card .source { margin-top: 0; }
.card-title {
  font-size: 13.5px; font-weight: 600; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
input {
  width: 100%; height: 34px; flex: none; padding: 0 10px; border-radius: 8px; border: 1px solid #2b2b31;
  background: #0f0f12; color: #ececf0; font: inherit; outline: none;
}
input::placeholder { color: #74747f; }
input:focus { border-color: #8fb3ff; }
input:disabled { opacity: .6; }
.label { margin: 2px 0 -4px; color: #74747f; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
/* Each place is its own card with room around it, so picking one feels like picking, not hitting a list line. */
.targets { display: grid; gap: 6px; flex: none; max-height: 252px; overflow-y: auto; padding: 2px; margin: -2px; }
.target {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 44px; padding: 0 8px 0 12px;
  border-radius: 10px; border: 1px solid #2b2b31; background: #202025; text-align: left; color: #ececf0;
  transition: background 120ms, border-color 120ms, transform 80ms;
}
.target svg { width: 16px; height: 16px; flex: none; color: #74747f; }
.target:hover svg, .target:focus-visible svg { color: #8fb3ff; }
.target:active:not(:disabled) { transform: scale(.98); }
@media (prefers-reduced-motion: reduce) { .target { transition: none; } .target:active:not(:disabled) { transform: none; } }
.target .name { flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target .path { flex: 1 1 0; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #74747f; font-size: 12px; }
.target .enter, .target .go { display: none; flex: none; margin-left: auto; }
.target .enter {
  height: 18px; padding: 0 5px; border-radius: 4px; border: 1px solid #3a3a42;
  color: #74747f; font-size: 11px; line-height: 16px;
}
.target .go {
  height: 24px; padding: 0 10px; border-radius: 999px; background: #8fb3ff; color: #0d1424;
  font-size: 12px; font-weight: 600; line-height: 24px;
}
.target.default .enter { display: block; }
.target:hover, .target:focus-visible { background: #26262c; border-color: #8fb3ff; outline: none; }
.target:hover .enter, .target:focus-visible .enter { display: none; }
.target:hover .go, .target:focus-visible .go { display: block; }
.target:disabled { cursor: default; }
.target.saving { border-color: #8fb3ff; }
.target.saving .enter { display: none; }
.target.saving .go { display: block; }
.busy .target:not(.saving) { opacity: .45; }
.busy .target:not(.saving) .enter { display: none; }
.empty { padding: 8px 10px; color: #74747f; font-size: 12px; }
.note { color: #ffb98a; font-size: 12px; }
.error { color: #ff8a80; font-size: 12px; }
.done { display: flex; align-items: center; gap: 8px; padding: 4px 2px; font-weight: 600; }
.done svg { width: 18px; height: 18px; flex: none; color: #6fd39b; }
.info { color: #ececf0; font-size: 12.5px; }
.overlay { position: fixed; inset: 0; z-index: 2147483647; }
.pick.over { cursor: pointer; }
/* Drawn over the page itself, not a dimmed one: a stronger blue than the panel's, to show on light and dark pictures. */
.highlight { position: fixed; border-radius: 4px; background: rgba(61,124,255,.18); box-shadow: inset 0 0 0 3px #3d7cff; pointer-events: none; }
.save {
  position: absolute; top: 8px; right: 8px; padding: 5px 11px; border-radius: 999px; white-space: nowrap;
  background: #3d7cff; color: #fff; font-size: 12px; font-weight: 600; line-height: 16px; box-shadow: 0 2px 8px rgba(0,0,0,.3);
}
.save.below { top: calc(100% + 6px); right: 0; }
.save.above { top: auto; bottom: calc(100% + 6px); right: 0; }
.region { cursor: crosshair; background: rgba(0,0,0,.2); }
.region.lit { background: transparent; }
.box { position: fixed; border: 1.5px solid #8fb3ff; box-shadow: 0 0 0 100vmax rgba(0,0,0,.35); pointer-events: none; }
.tag { position: absolute; left: -2px; bottom: calc(100% + 6px); padding: 3px 8px; border-radius: 6px; white-space: nowrap;
  background: #8fb3ff; color: #0d1424; font-size: 12px; font-weight: 600; line-height: 16px; }
.tag.inside { bottom: auto; top: 6px; left: 6px; }
.hint {
  position: fixed; top: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  height: 42px; padding: 0 18px 0 15px; border-radius: 21px; white-space: nowrap; pointer-events: none;
  background: #1a1a1e; color: #fff; font-size: 14px; font-weight: 600;
  border: 1px solid #45454e; box-shadow: 0 10px 30px rgba(0,0,0,.4), 0 2px 6px rgba(0,0,0,.25);
  animation: drop 160ms cubic-bezier(.2,.9,.3,1);
}
@keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }
@media (prefers-reduced-motion: reduce) { .hint { animation: none; } }
.hint svg { width: 18px; height: 18px; flex: none; color: #8fb3ff; }
.hint .sep { width: 1px; height: 16px; background: #3a3a42; }
.hint kbd {
  height: 20px; padding: 0 6px; border-radius: 5px; border: 1px solid #45454e; background: #26262c;
  color: #a3a3ae; font: 500 11.5px/18px Inter, -apple-system, BlinkMacSystemFont, sans-serif;
}
`;

/**
 * A shadow-DOM host so page styles can't touch our UI and page hotkeys don't see our typing. One at a time:
 * a new one replaces whatever capture UI was showing, and the floating button stays hidden while one is open.
 */
export function createHost(css = STYLE): { host: HTMLElement; root: ShadowRoot } {
  document.querySelector(CAPTURE_TAG)?.remove();
  const host = document.createElement(CAPTURE_TAG);
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  document.documentElement.append(host);
  return { host, root };
}

/** What a click on the highlighted thing saves. A canvas or SVG is saved as a picture of it, which is still an image. */
const SAVE_LABELS: Record<Target['type'], string> = { image: 'Save image', video: 'Save frame', element: 'Save image' };
const PICK_HINT = 'Click an image to save it';
/** Anything smaller is an icon or a button, not a reference. */
const MIN_TARGET = 32;

/**
 * Save image. Pointing at an image or video highlights it, and a click saves it whole at full resolution,
 * so with several on screen you simply point at the one you want. The page still scrolls underneath.
 * Resolves null on Escape, a right-click, or a click away from any image: all ways of leaving.
 */
export function pickImage(pointer: Point | null): Promise<Target | null> {
  return new Promise((resolve) => {
    const { host, root } = createHost();
    const overlay = el('div', { className: 'overlay pick' });
    const highlight = el('div', { className: 'highlight' });
    const save = el('div', { className: 'save' });
    const hint = el(
      'div',
      { className: 'hint' },
      icon(ICONS.image),
      el('span', { textContent: PICK_HINT }),
      el('span', { className: 'sep' }),
      el('kbd', { textContent: 'Esc', title: 'Esc to cancel' }),
    );
    highlight.hidden = true;
    highlight.append(save);
    overlay.append(highlight, hint);
    root.append(overlay);

    let hovered: Target | null = null;
    let frame = 0;

    // Looks again after the pointer moves or the page scrolls under it.
    const look = () => {
      frame = 0;
      hovered = pointer && targetAt(pointer);
      const r = hovered && visibleRect(hovered.el);
      overlay.classList.toggle('over', r !== null);
      highlight.hidden = r === null;
      if (!hovered || !r) return;
      Object.assign(highlight.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
      // Follow a rounded image's corners, unless the screen edge cuts it off.
      const whole = hovered.el.getBoundingClientRect();
      const cut = r.width < whole.width - 1 || r.height < whole.height - 1;
      highlight.style.borderRadius = cut ? '' : getComputedStyle(hovered.el).borderRadius;
      save.textContent = SAVE_LABELS[hovered.type];
      // On a small image the label goes outside it, below unless that is off the screen.
      const small = r.width < 120 || r.height < 48;
      save.classList.toggle('below', small && r.y + r.height + 30 < innerHeight);
      save.classList.toggle('above', small && r.y + r.height + 30 >= innerHeight);
    };
    const lookSoon = () => {
      frame ||= requestAnimationFrame(look);
    };
    const finish = (result: Target | null) => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', lookSoon, true);
      host.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', lookSoon, { capture: true, passive: true });
    look();

    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      finish(null);
    });
    overlay.addEventListener('pointermove', (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      lookSoon();
    });
    overlay.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      // Clicking away from any image leaves, like Esc.
      finish(hovered);
    });
  });
}

/** Capture area: drag out a part of the screen to save as a picture. Resolves null on Escape or a right-click. */
export function selectArea(): Promise<Rect | null> {
  return new Promise((resolve) => {
    const { host, root } = createHost();
    const overlay = el('div', { className: 'overlay region' });
    const box = el('div', { className: 'box' });
    const tag = el('div', { className: 'tag' });
    const hint = el(
      'div',
      { className: 'hint' },
      icon(ICONS.area),
      el('span', { textContent: 'Drag to capture an area' }),
      el('span', { className: 'sep' }),
      el('kbd', { textContent: 'Esc', title: 'Esc to cancel' }),
    );
    box.hidden = true;
    box.append(tag);
    overlay.append(box, hint);
    root.append(overlay);

    let start: Point | null = null;
    let rect: Rect | null = null;
    const finish = (result: Rect | null) => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener('keydown', onKey, true);

    overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      finish(null);
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      rect = null;
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!start) return;
      // A small wobble while clicking is not an area.
      if (!rect && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      hint.hidden = true;
      rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y),
      };
      overlay.classList.add('lit');
      box.hidden = false;
      Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      tag.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      tag.classList.toggle('inside', rect.y < 30);
    });
    overlay.addEventListener('pointerup', (e) => {
      if (!start || e.button !== 0) return;
      start = null;
      if (rect && rect.width > 8 && rect.height > 8) return finish(rect);
      // Too small to be meant: start over.
      rect = null;
      box.hidden = true;
      hint.hidden = false;
      overlay.classList.remove('lit');
    });
  });
}

/** The image, video or canvas under the point, when it is big enough to be a reference. */
function targetAt(point: Point): Target | null {
  const target = resolveTarget(point);
  const r = target && visibleRect(target.el);
  return r && r.width >= MIN_TARGET && r.height >= MIN_TARGET ? target : null;
}

/** A short message in the panel position, for errors before a draft exists. */
export function showMessage(text: string, tone: 'error' | 'info' = 'error'): void {
  const { host, root } = createHost();
  root.append(el('div', { className: 'panel' }, el('div', { className: tone, textContent: text })));
  setTimeout(() => host.remove(), 4000);
}

/**
 * The save panel. What the reference is and where it came from are detected, so the one choice is where it
 * goes: clicking a place saves there, and Enter saves to the highlighted one (the last place used).
 */
export function openSavePanel(draft: Draft, status: StatusResponse): void {
  const { host, root } = createHost();
  const close = () => {
    window.removeEventListener('keydown', onEscape, true);
    host.remove();
  };
  const onEscape = (e: KeyboardEvent) => {
    // Escape during IME composition cancels the composition, not the panel.
    if (e.key === 'Escape' && !e.isComposing) close();
  };
  window.addEventListener('keydown', onEscape, true);

  const why = el('input', { placeholder: 'Why it matters (optional)', ariaLabel: 'Why it matters' });
  const entries = saveTargets(status.collections, status.lastTargetId).map((target) => ({ target, row: targetRow(target) }));
  const rows = entries.map(({ row }) => row);
  const filter = entries.length > FILTER_AFTER ? el('input', { placeholder: 'Find a project', ariaLabel: 'Find a project' }) : null;
  const empty = el('div', { className: 'empty', textContent: 'No project by that name' });
  empty.hidden = true;
  const feedback = el('div');
  if (!status.online) {
    feedback.className = 'note';
    feedback.textContent = "Otter Pocket isn't open. This will be saved when it opens.";
  }

  const panel = el(
    'div',
    { className: 'panel' },
    el('header', {}, icon(ICONS.vault, 'mark'), el('b', { textContent: 'Save to Otter Pocket' }), closeButton(close)),
    ...preview(draft),
    why,
    el('div', { className: 'label', textContent: 'Save to' }),
  );
  if (filter) panel.append(filter);
  panel.append(el('div', { className: 'targets' }, ...rows, empty), feedback);
  root.append(panel);
  why.focus();

  const visible = () => entries.filter(({ row }) => !row.hidden);
  const markDefault = () => {
    const first = visible()[0];
    rows.forEach((row) => row.classList.toggle('default', row === first?.row));
    empty.hidden = first !== undefined;
  };
  markDefault();

  let saving = false;
  const setDisabled = (disabled: boolean) => {
    for (const control of [why, filter, ...rows]) if (control) control.disabled = disabled;
  };
  const save = async (entry: { target: SaveTarget; row: HTMLButtonElement } | undefined) => {
    if (!entry || saving) return;
    const { target, row } = entry;
    saving = true;
    const go = row.querySelector('.go')!;
    panel.classList.add('busy');
    row.classList.add('saving');
    go.textContent = 'Saving…';
    setDisabled(true);
    try {
      const result = await ask<SaveResponse>({
        type: 'save-capture',
        request: {
          targetId: target.id,
          kind: draft.kind,
          title: draft.title,
          why: why.value.trim(),
          source: draft.source,
          image: draft.image,
        },
      });
      const text = result.result === 'saved' ? `Saved to ${result.targetName}` : `Saves to ${result.targetName} when Otter Pocket opens`;
      panel.replaceChildren(el('div', { className: 'done' }, icon(ICONS.check), el('span', { textContent: text })));
      setTimeout(close, 1400);
    } catch (e) {
      saving = false;
      panel.classList.remove('busy');
      row.classList.remove('saving');
      go.textContent = 'Save';
      setDisabled(false);
      feedback.className = 'error';
      feedback.textContent = e instanceof Error ? e.message : String(e);
      row.focus();
    }
  };

  const enterSaves = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing) return false;
    e.preventDefault();
    void save(visible()[0]);
    return true;
  };
  why.addEventListener('keydown', (e) => {
    if (enterSaves(e)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (filter ?? visible()[0]?.row)?.focus();
    }
  });
  filter?.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    for (const { target, row } of entries) {
      row.hidden = query !== '' && !`${target.path} ${target.name}`.toLowerCase().includes(query);
    }
    markDefault();
  });
  filter?.addEventListener('keydown', (e) => {
    if (enterSaves(e)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      (e.key === 'ArrowDown' ? visible()[0]?.row : why)?.focus();
    }
  });
  for (const entry of entries) {
    const { row } = entry;
    row.addEventListener('click', () => void save(entry));
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const shown = visible().map((v) => v.row);
      const next = shown[shown.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
      (next ?? (e.key === 'ArrowUp' ? (filter ?? why) : row)).focus();
    });
  }
}

/** What is being kept: the picture and where it's from, or a link card for a page without a picture. */
function preview(draft: Draft): HTMLElement[] {
  const { source } = draft;
  const time = source.videoTime != null ? ` · ${formatTimestamp(source.videoTime)}` : '';
  const where = el('div', { className: 'source', title: source.pageUrl });
  if (source.faviconUrl) where.append(el('img', { src: source.faviconUrl, alt: '' }));
  where.append(el('span', { textContent: `${source.site ?? source.pageUrl}${time}` }));
  if (draft.image) return [el('img', { className: 'preview', src: draft.image.dataUrl, alt: '' }), where];
  const title = draft.title || source.pageTitle || source.site || source.pageUrl;
  return [el('div', { className: 'card' }, el('div', { className: 'card-title', textContent: title }), where)];
}

function closeButton(onClick: () => void): HTMLButtonElement {
  const button = el('button', { className: 'close', textContent: '×', type: 'button', title: 'Close (Esc)', ariaLabel: 'Close' });
  button.addEventListener('click', onClick);
  return button;
}

interface SaveTarget {
  id: string;
  name: string;
  /** The folders a project sits in, e.g. "Clients / 2026"; empty at the top level. */
  path: string;
  vault: boolean;
}

/** The last place used first, then the Vault, then projects by folder. */
function saveTargets(collections: CollectionSummary[], lastTargetId: string): SaveTarget[] {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const folders = (c: CollectionSummary): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let parent = c.parentId ? byId.get(c.parentId) : undefined; parent && !seen.has(parent.id); ) {
      seen.add(parent.id);
      names.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return names.join(' / ');
  };
  const vault = collections.find((c) => c.kind === 'vault');
  const projects = collections
    .filter((c) => c.kind === 'project')
    .map((c) => ({ id: c.id, name: c.name, path: folders(c), vault: false }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  const targets: SaveTarget[] = [{ id: VAULT_ID, name: vault?.name ?? 'Vault', path: '', vault: true }, ...projects];
  const last = targets.findIndex((t) => t.id === lastTargetId);
  if (last > 0) targets.unshift(...targets.splice(last, 1));
  return targets;
}

function targetRow(target: SaveTarget): HTMLButtonElement {
  const row = el('button', {
    className: 'target',
    type: 'button',
    title: target.path ? `${target.path} / ${target.name}` : target.name,
  });
  row.append(icon(target.vault ? ICONS.vault : ICONS.project), el('span', { className: 'name', textContent: target.name }));
  if (target.path) row.append(el('span', { className: 'path', textContent: target.path }));
  row.append(el('span', { className: 'enter', textContent: '↵', title: 'Enter saves here' }), el('span', { className: 'go', textContent: 'Save' }));
  return row;
}
