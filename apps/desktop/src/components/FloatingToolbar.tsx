import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface ToolOption {
  id: string;
  label: string;
  hint?: string;
  /** A small picture of what the option does, shown in place of an icon. */
  sample: ReactNode;
  /** The one the tool's own button runs, ticked in the menu. */
  current?: boolean;
  onClick(): void;
}

export interface Tool {
  id: string;
  icon?: IconName;
  /** Words shown on the button, for actions an icon can't say (e.g. which group it changes). */
  text?: string;
  label: string;
  /** Shown in the tooltip, e.g. "F". */
  shortcut?: string;
  /** For on/off tools: whether it is on. Leave out for one-shot actions. */
  pressed?: boolean;
  /**
   * Choices that open in a menu; picking one runs it. Without `onClick` the tool's button opens the menu.
   * With it the button runs `onClick` straight away and a small arrow beside it opens the menu.
   */
  options?: ToolOption[];
  onClick?(): void;
  /** The tooltip of the arrow that opens the menu, when there is one. */
  optionsLabel?: string;
}

interface Props {
  groups: Tool[][];
  /** Notices such as toasts. They sit above the bar, and above an open menu, so nothing covers anything. */
  children?: ReactNode;
}

/** Tools in a bar floating over the bottom of the board, like a design app's. */
export function FloatingToolbar({ groups, children }: Props) {
  return (
    <div className="float-dock">
      {children}
      <ToolBar groups={groups} />
    </div>
  );
}

interface ToolBarProps {
  groups: Tool[][];
  /** Where a tool's choices open: away from whatever the bar is attached to. */
  menuSide?: 'above' | 'below';
  label?: string;
  /** Shown at the start of the bar, before the tools, e.g. what they act on. */
  start?: ReactNode;
}

/**
 * A bar of tools. Each group is set off by a divider; empty groups are left out, so a view can drop the
 * tools that don't apply to it. Renders the bar and its open menu side by side, for the parent to stack.
 */
export function ToolBar({ groups, menuSide = 'above', label = 'Tools', start }: ToolBarProps) {
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
  const menuList = menu && (
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
          {option.current && (
            <span className="tool-menu-current" aria-label="Default">
              <Icon name="check" size={14} />
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {menuSide === 'above' && menuList}
      {shown.length > 0 && (
        <div className="float-toolbar" role="toolbar" aria-label={label} ref={barRef}>
          {start}
          {start && <span className="float-toolbar-divider" aria-hidden />}
          {shown.map((group, i) => (
            <Fragment key={group[0]!.id}>
              {i > 0 && <span className="float-toolbar-divider" aria-hidden />}
              {group.map((tool) => {
                const open = openId === tool.id;
                const toggle = () => setOpenId(open ? null : tool.id);
                const tip = (
                  <span className="tool-tip" aria-hidden>
                    {tool.label}
                    {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                  </span>
                );
                if (tool.options && tool.onClick) {
                  return (
                    <span key={tool.id} className="tool-split">
                      <button type="button" className="tool" aria-label={tool.label} onClick={tool.onClick}>
                        {tool.icon && <Icon name={tool.icon} size={17} />}
                        {tip}
                      </button>
                      <button
                        type="button"
                        className={`tool tool-more ${menuSide}`}
                        aria-label={tool.optionsLabel ?? 'More'}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onClick={toggle}
                      >
                        <Icon name="chevron" size={11} />
                        <span className="tool-tip" aria-hidden>
                          {tool.optionsLabel ?? 'More'}
                        </span>
                      </button>
                    </span>
                  );
                }
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className={tool.text ? 'tool has-text' : 'tool'}
                    aria-label={tool.label}
                    aria-pressed={tool.pressed}
                    aria-haspopup={tool.options ? 'menu' : undefined}
                    aria-expanded={tool.options ? open : undefined}
                    onClick={tool.options ? toggle : tool.onClick}
                  >
                    {tool.icon && <Icon name={tool.icon} size={tool.text ? 15 : 17} />}
                    {tool.text && <span className="tool-text">{tool.text}</span>}
                    {tip}
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
      {menuSide === 'below' && menuList}
    </>
  );
}
