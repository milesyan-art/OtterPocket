import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface ToolOption {
  id: string;
  label: string;
  hint?: string;
  /** A small picture of what the option does, shown in place of an icon. */
  sample: ReactNode;
  onClick(): void;
}

export interface Tool {
  id: string;
  icon: IconName;
  label: string;
  /** Shown in the tooltip, e.g. "F". */
  shortcut?: string;
  /** For on/off tools: whether it is on. Leave out for one-shot actions. */
  pressed?: boolean;
  /** Choices that open above the bar when the tool is clicked; picking one runs it. */
  options?: ToolOption[];
  /** For tools without options. */
  onClick?(): void;
}

interface Props {
  groups: Tool[][];
  /** Notices such as toasts. They sit above the bar, and above an open menu, so nothing covers anything. */
  children?: ReactNode;
}

/**
 * Tools in a bar floating over the bottom of the board, like a design app's. Each group is set off by a
 * divider; empty groups are left out, so a view can drop the tools that don't apply to it.
 */
export function FloatingToolbar({ groups, children }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openId) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !barRef.current?.contains(target)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  const shown = groups.filter((group) => group.length > 0);
  const menu = shown.flat().find((tool) => tool.id === openId)?.options;
  return (
    <div className="float-dock">
      {children}
      {menu && (
        <div className="tool-menu" role="menu" ref={menuRef}>
          {menu.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpenId(null);
                option.onClick();
              }}
            >
              <span className="tool-menu-sample">{option.sample}</span>
              <span className="tool-menu-text">
                <span>{option.label}</span>
                {option.hint && <span className="tool-menu-hint">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div className="float-toolbar" role="toolbar" aria-label="Tools" ref={barRef}>
          {shown.map((group, i) => (
            <Fragment key={group[0]!.id}>
              {i > 0 && <span className="float-toolbar-divider" aria-hidden />}
              {group.map((tool) => {
                const open = openId === tool.id;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className="tool"
                    aria-label={tool.label}
                    aria-pressed={tool.pressed}
                    aria-haspopup={tool.options ? 'menu' : undefined}
                    aria-expanded={tool.options ? open : undefined}
                    onClick={tool.options ? () => setOpenId(open ? null : tool.id) : tool.onClick}
                  >
                    <Icon name={tool.icon} size={17} />
                    <span className="tool-tip" aria-hidden>
                      {tool.label}
                      {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
