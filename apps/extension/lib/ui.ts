const SVG_NS = 'http://www.w3.org/2000/svg';

/** Line icons on a 24px grid, drawn like the desktop app's (apps/desktop/src/components/Icon.tsx). */
export const ICONS = {
  vault: 'M12 3l7 4v10l-7 4-7-4V7l7-4zm0 0v18M5 7l7 4 7-4',
  project: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  check: 'M5 12l5 5 9-10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16.5l4.3-4.3a1 1 0 0 1 1.4 0L15 17.5M13.5 16l1.8-1.8a1 1 0 0 1 1.4 0l3.3 3.3M15.5 8.5h.01',
  area: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3',
  video: 'M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM10 9.2v5.6l4.6-2.8L10 9.2z',
  bookmark: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z',
  dock: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM20 10h-3v4h3',
  keyboard: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8',
  hide: 'M3 3l18 18M10.6 5.1A9.7 9.7 0 0 1 12 5c4.6 0 8 3.5 9.5 7a12 12 0 0 1-2.2 3.3M6.6 6.6C4.6 7.9 3.3 9.9 2.5 12c1.5 3.5 4.9 7 9.5 7 1.8 0 3.4-.5 4.8-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2',
  power: 'M12 3.5v7.5M6.3 6.8a8 8 0 1 0 11.4 0',
};

export type IconName = keyof typeof ICONS;

/** Tiny element builder: `el('button', { className: 'save' }, 'Save')`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function icon(path: string, className?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs: Record<string, string> = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  if (className) attrs.class = className;
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  const shape = document.createElementNS(SVG_NS, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

/** Chrome writes a shortcut as "⌥⇧A" on a Mac and "Alt+Shift+A" elsewhere: one keycap per key. */
export function keycaps(shortcut: string | undefined): HTMLElement[] {
  if (!shortcut) return [];
  const keys = shortcut.includes('+') ? shortcut.split('+') : Array.from(shortcut);
  return keys.map((key) => el('kbd', { textContent: key }));
}
