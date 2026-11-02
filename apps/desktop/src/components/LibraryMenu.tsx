import { useEffect, useRef, useState } from 'react';
import type { LibraryInfo, SetupAction } from '../api';
import { Icon } from './Icon';
import { fileManager } from './LibraryProblem';

interface Props {
  library: LibraryInfo;
  onReveal(): void;
  onSwitch(action: SetupAction): void;
}

/**
 * The library folder, at the foot of the sidebar: rarely needed, but easy to find when you want your files.
 * The card opens what you can do with the folder; the button beside it goes straight to it.
 */
export function LibraryMenu({ library, onReveal, onSwitch }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const parts = library.displayPath.split(' › ');
  const name = parts.pop() || library.displayPath;
  const where = parts.length > 0 ? `Library in ${parts.join(' › ')}` : 'Library folder';

  return (
    <div className="library-menu" ref={ref}>
      {open && (
        <div className="library-popover" role="menu">
          <div className="popover-head">
            <span className="popover-label">Library folder</span>
            <span className="popover-path" title={library.root}>
              {library.displayPath}
            </span>
          </div>
          <button role="menuitem" onClick={choose(onReveal)}>
            <Icon name="finder" size={14} /> Show in {fileManager}
          </button>
          <button role="menuitem" onClick={choose(() => onSwitch({ kind: 'open' }))}>
            <Icon name="folder" size={14} /> Open another library…
          </button>
          <button role="menuitem" onClick={choose(() => onSwitch({ kind: 'choose' }))}>
            <Icon name="plus" size={14} /> New library…
          </button>
          <p className="popover-tip">
            Everything is in this folder. To move to another computer, quit Otter Pocket, copy the folder over, and open it
            there.
          </p>
        </div>
      )}
      <div className={`library-card${open ? ' open' : ''}`}>
        <button
          className="library-main"
          onClick={() => setOpen((o) => !o)}
          title={library.root}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="library-icon">
            <Icon name="folder" size={15} />
          </span>
          <span className="library-text">
            <span className="library-name">{name}</span>
            <span className="library-where">{where}</span>
          </span>
        </button>
        <button className="library-reveal" onClick={choose(onReveal)} aria-label={`Show in ${fileManager}`} title={`Show in ${fileManager}`}>
          <Icon name="finder" size={14} />
        </button>
      </div>
    </div>
  );
}
