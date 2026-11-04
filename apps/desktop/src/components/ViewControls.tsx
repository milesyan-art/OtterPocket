import { useEffect, useRef, useState } from 'react';
import { isTyping } from '../board/Board';
import { ToolBar } from './FloatingToolbar';

interface Props {
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
}

/** A mouse or trackpad gesture, drawn as a small glyph beside its name. */
type Gesture = 'button' | 'wheel' | 'swipe' | 'pinch';

/** A keycap, "/" between the shortcuts of a pair ("Zoom in / out"), or a gesture. Keycaps side by side are held together. */
type Key = string | { gesture: Gesture; label: string };

interface Section {
  title: string;
  rows: { action: string; keys: Key[] }[];
}

/**
 * One way per action, the best-known one, as in a Mac menu: other ways keep working without a row (middle-drag
 * pans, ⌘ + two fingers zooms). Things that work as in every Mac app (⇧-click, Esc) have no row either.
 */
const SECTIONS: Section[] = [
  {
    title: 'View',
    rows: [
      { action: 'Pan', keys: ['Space', { gesture: 'button', label: 'Drag' }] },
      { action: 'Zoom', keys: ['⌘', { gesture: 'wheel', label: 'Scroll' }] },
      { action: 'Zoom in / out', keys: ['+', '/', '−'] },
      { action: 'Fit everything', keys: ['F'] },
    ],
  },
  {
    // Only panning and zooming differ on a trackpad. It always scrolls with two fingers (only the direction is
    // a setting), so the gesture is named, not "scroll".
    title: 'Trackpad',
    rows: [
      { action: 'Pan', keys: [{ gesture: 'swipe', label: 'Two Finger Swipe' }] },
      { action: 'Zoom', keys: [{ gesture: 'pinch', label: 'Pinch' }] },
    ],
  },
  {
    title: 'References',
    rows: [
      { action: 'Go back to the source', keys: [{ gesture: 'button', label: 'Double Click' }] },
      { action: 'Select all', keys: ['⌘', 'A'] },
      { action: 'Group', keys: ['⌘', 'G'] },
      { action: 'Ungroup', keys: ['⇧', '⌘', 'G'] },
      { action: 'Remove', keys: ['⌫'] },
    ],
  },
  {
    title: 'Edit',
    rows: [
      { action: 'Undo', keys: ['⌘', 'Z'] },
      { action: 'Redo', keys: ['⇧', '⌘', 'Z'] },
    ],
  },
];

function Keys({ keys }: { keys: Key[] }) {
  return (
    <span className="shortcut-keys">
      {keys.map((key, i) =>
        typeof key !== 'string' ? (
          <span className="shortcut-gesture" key={i}>
            <span className={`glyph glyph-${key.gesture}`} aria-hidden />
            {key.label}
          </span>
        ) : key === '/' ? (
          <span className="shortcut-sep" key={i}>
            /
          </span>
        ) : (
          <kbd key={i}>{key}</kbd>
        ),
      )}
    </span>
  );
}

function ShortcutSheet() {
  return (
    <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <h3>Keyboard shortcuts</h3>
      {SECTIONS.map((section) => (
        <section key={section.title}>
          <h4>{section.title}</h4>
          {section.rows.map((row) => (
            <div className="shortcut-row" key={row.action}>
              <span>{row.action}</span>
              <Keys keys={row.keys} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Zoom and fit in a small bar at the bottom right of the board, with a help button for the shortcuts. */
export function ViewControls({ onZoomIn, onZoomOut, onFit }: Props) {
  const [helpOpen, setHelpOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      if (e.key === '?') setHelpOpen((open) => !open);
      else if (e.key === 'Escape') setHelpOpen(false);
      else return;
      e.preventDefault();
    };
    const onPointer = (e: PointerEvent) => {
      if (!dockRef.current?.contains(e.target as Node)) setHelpOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  return (
    <div className="view-dock" ref={dockRef}>
      {helpOpen && <ShortcutSheet />}
      <ToolBar
        label="View"
        groups={[
          [
            { id: 'zoom-out', icon: 'minus', label: 'Zoom out', shortcut: '−', onClick: onZoomOut },
            { id: 'zoom-in', icon: 'plus', label: 'Zoom in', shortcut: '+', onClick: onZoomIn },
            { id: 'fit', icon: 'fit', label: 'Fit everything', shortcut: 'F', onClick: onFit },
          ],
          [
            {
              id: 'help',
              icon: 'help',
              label: 'Keyboard shortcuts',
              shortcut: '?',
              pressed: helpOpen,
              onClick: () => setHelpOpen((open) => !open),
            },
          ],
        ]}
      />
    </div>
  );
}
