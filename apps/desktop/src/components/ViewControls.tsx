import { useEffect, useRef, useState } from 'react';
import { isTyping } from '../board/Board';
import { ToolBar } from './FloatingToolbar';

interface Props {
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
}

/**
 * What it does, then the keys or gestures. Each is one <kbd>, held together; "or" starts another way to do the
 * same, "/" the shortcut for the second action of a pair ("Undo / Redo").
 */
const SHORTCUTS: { title: string; rows: [keys: string[], action: string][] }[] = [
  {
    title: 'View',
    rows: [
      [['Space', 'Drag'], 'Pan'],
      [['⌘', 'Scroll wheel'], 'Zoom'],
      [['+', '/', '−'], 'Zoom in / out'],
      [['F'], 'Fit everything'],
    ],
  },
  {
    // Only panning and zooming differ on a trackpad. A Mac trackpad always scrolls with two fingers (only the
    // direction is a setting), so name the fingers rather than "scroll".
    title: 'Trackpad',
    rows: [
      [['Two fingers'], 'Pan'],
      [['Pinch', 'or', '⌘', 'Two fingers'], 'Zoom'],
    ],
  },
  {
    title: 'References',
    rows: [
      [['Double-click'], 'Go back to the source'],
      [['⌘', 'A'], 'Select all'],
      [['⌘', 'G', '/', '⇧', '⌘', 'G'], 'Group / Ungroup'],
      [['⌫'], 'Remove'],
    ],
  },
  {
    title: 'Edit',
    rows: [[['⌘', 'Z', '/', '⇧', '⌘', 'Z'], 'Undo / Redo']],
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
                    {keys.map((key, i) =>
                      key === 'or' || key === '/' ? (
                        <span className="shortcut-or" key={i}>
                          {key}
                        </span>
                      ) : (
                        <kbd key={i}>{key}</kbd>
                      ),
                    )}
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
