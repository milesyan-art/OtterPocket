import { useEffect, useRef, useState } from 'react';
import { isTyping } from '../board/Board';
import { ToolBar } from './FloatingToolbar';

interface Props {
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
}

/** Keys, then what they do. Each key is one <kbd>; "+" between them means together. */
const SHORTCUTS: { title: string; rows: [keys: string[], action: string][] }[] = [
  {
    title: 'View',
    rows: [
      [['Space', 'Drag'], 'Pan'],
      [['Scroll'], 'Pan (trackpad)'],
      [['⌘', 'Scroll'], 'Zoom (or pinch)'],
      [['+'], 'Zoom in'],
      [['−'], 'Zoom out'],
      [['F'], 'Fit everything'],
    ],
  },
  {
    title: 'Select',
    rows: [
      [['Drag'], 'Select with a box'],
      [['⇧', 'Click'], 'Add to the selection'],
      [['⌘', 'A'], 'Select all'],
      [['Esc'], 'Select nothing'],
    ],
  },
  {
    title: 'References',
    rows: [
      [['Double-click'], 'Go back to the source'],
      [['⌘', 'G'], 'Group'],
      [['⇧', '⌘', 'G'], 'Ungroup'],
      [['⌫'], 'Remove'],
    ],
  },
  {
    title: 'Edit',
    rows: [
      [['⌘', 'Z'], 'Undo'],
      [['⇧', '⌘', 'Z'], 'Redo'],
    ],
  },
  {
    title: 'Help',
    rows: [[['?'], 'Show these shortcuts']],
  },
];

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
      {helpOpen && (
        <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts">
          <h3>Keyboard shortcuts</h3>
          {SHORTCUTS.map((section) => (
            <section key={section.title}>
              <h4>{section.title}</h4>
              {section.rows.map(([keys, action]) => (
                <div className="shortcut-row" key={keys.join() + action}>
                  <span>{action}</span>
                  <span className="shortcut-keys">
                    {keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
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
