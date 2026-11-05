import { useEffect, useRef, useState } from 'react';
import { formatTimestamp, siteName } from '@otterpocket/shared';
import { Board, isTyping, type ScreenRect } from '../board/Board';
import type { BoardItem, BoardView, Group, LayoutUpdate } from '../api';
import { Favicon } from './Favicon';
import type { Tool } from './FloatingToolbar';
import { SelectionToolbar } from './SelectionToolbar';
import { ViewControls } from './ViewControls';

interface Props {
  boardId: string;
  /** Where this board was left last time, or null to fit it to the screen. */
  view: BoardView | null;
  items: BoardItem[];
  groups: Group[];
  /** The group whose title is being typed, in a text field over the board. */
  editingGroupId: string | null;
  /** In the order they were picked. */
  selectedIds: string[];
  /** The group picked by its title, when the selection is that group; a group of one is then still a group. */
  pickedGroup: string | null;
  grayscale: boolean;
  /** A newly saved item to bring into view and select, once it is on this board. */
  reveal: { boardId: string; itemId: string } | null;
  /** The floating inspector while it is open over the board, so what's selected can be kept out from under it. */
  inspector: HTMLElement | null;
  /** What can be done to several selected references at once, floating by them. */
  selectionTools: Tool[][];
  onRevealed(itemId: string): void;
  onSelect(itemIds: string[], groupId?: string | null): void;
  /** A click on an item, as opposed to a press that drags it or Shift or ⌘ that adds it to the selection. */
  onInspect(itemId: string): void;
  onOpenSource(itemId: string): void;
  onRemove(itemIds: string[]): void;
  /** ⌘G: group what's selected (or update the group it shares references with). */
  onGroup(): void;
  /** ⇧⌘G: take what's selected out of its groups. */
  onUngroup(): void;
  /** Start (a group id) or stop (null) editing a group's title. */
  onEditTitle(groupId: string | null): void;
  onRenameGroup(groupId: string, title: string): void;
  onLayoutChange(updates: LayoutUpdate[]): void;
  /** References dragged wholly out of their groups' frames: they leave the groups, and the move is kept with it. */
  onLeaveGroups(updates: LayoutUpdate[], itemIds: string[]): void;
  onViewChange(boardId: string, view: BoardView): void;
}

export function BoardCanvas(props: Props) {
  const { boardId, items, groups, editingGroupId, selectedIds, pickedGroup, grayscale, reveal, inspector } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<Board | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Where the selection is on screen, and whether it is being dragged.
  const [selection, setSelection] = useState<{ rect: ScreenRect; held: boolean } | null>(null);
  const [titleSpot, setTitleSpot] = useState<{ rect: ScreenRect; fontSize: number } | null>(null);

  useEffect(() => {
    const board = new Board({
      select: (ids, groupId) => latest.current.onSelect(ids, groupId),
      clicked: (id) => latest.current.onInspect(id),
      openSource: (id) => latest.current.onOpenSource(id),
      layoutChanged: (updates) => latest.current.onLayoutChange(updates),
      leftGroups: (updates, ids) => latest.current.onLeaveGroups(updates, ids),
      selectionMoved: (rect, held) => setSelection(rect && { rect, held }),
      viewChanged: (boardId, view) => latest.current.onViewChange(boardId, view),
      revealed: (id) => latest.current.onRevealed(id),
      renameGroup: (id) => latest.current.onEditTitle(id),
      titleMoved: (rect, fontSize) => setTitleSpot(rect && { rect, fontSize }),
    });
    boardRef.current = board;
    board.setItems(latest.current.items, latest.current.boardId, latest.current.view);
    board.setGroups(latest.current.groups);
    board.editTitle(latest.current.editingGroupId);
    board.select(latest.current.selectedIds, latest.current.pickedGroup);
    board.setGrayscale(latest.current.grayscale);
    void board.init(hostRef.current!);
    return () => {
      board.destroy();
      boardRef.current = null;
    };
  }, []);

  // The view only matters when the board changes, so it is read from the latest props rather than a dependency.
  useEffect(() => boardRef.current?.setItems(items, boardId, latest.current.view), [items, boardId]);
  // After the items, so a board's groups never meet the previous board's items.
  useEffect(() => boardRef.current?.setGroups(groups), [groups]);
  useEffect(() => boardRef.current?.editTitle(editingGroupId), [editingGroupId]);
  useEffect(() => boardRef.current?.select(selectedIds, pickedGroup), [selectedIds, pickedGroup]);
  useEffect(() => boardRef.current?.setGrayscale(grayscale), [grayscale]);
  // Both sit in the same box, so the panel's distance from the right is in the canvas's terms. Offsets, not
  // rects, so the panel's opening animation doesn't skew it.
  useEffect(() => {
    const host = hostRef.current;
    boardRef.current?.setCoveredRight(inspector && host ? host.offsetWidth - inspector.offsetLeft : 0);
  }, [inspector]);
  // After setItems, so a reveal that comes with a board switch is kept for the board it is for.
  useEffect(() => {
    if (reveal) boardRef.current?.reveal(reveal.boardId, reveal.itemId);
  }, [reveal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const board = boardRef.current;
      const { items, selectedIds, onSelect, onRemove, onGroup, onUngroup } = latest.current;
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'a') onSelect(items.map((b) => b.item.id));
        else if (e.code === 'KeyG') (e.shiftKey ? onUngroup : onGroup)();
        else return;
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) onRemove(selectedIds);
      else if (e.key === 'f') board?.fitAll();
      else if (e.key === '=' || e.key === '+') board?.zoomBy(1.25);
      else if (e.key === '-') board?.zoomBy(0.8);
      else if (e.key === 'Escape') onSelect([]);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The source badge is for one reference at a time; the selection's tools for several, or for a group.
  const selected =
    selectedIds.length === 1 && !pickedGroup ? items.find((b) => b.item.id === selectedIds[0])?.item : undefined;
  const badge = selected && selection?.rect;
  const host = hostRef.current;

  return (
    <div className="board">
      <div ref={hostRef} className="board-canvas" />
      {selected && badge && (
        <button
          className="source-badge"
          style={{ left: Math.max(8, badge.x), top: badge.y > 40 ? badge.y - 34 : badge.y + 8 }}
          onClick={() => props.onOpenSource(selected.id)}
          title="Go back to where this came from"
        >
          <Favicon url={selected.source.faviconUrl} />
          <span>{selected.source.site || siteName(selected.source.pageUrl)}</span>
          {selected.source.videoTime != null && <span className="badge-time">▶ {formatTimestamp(selected.source.videoTime)}</span>}
          <span aria-hidden>↗</span>
        </button>
      )}
      {editingGroupId && titleSpot && (
        <GroupTitleField
          key={editingGroupId}
          spot={titleSpot}
          title={groups.find((g) => g.id === editingGroupId)?.title ?? ''}
          onDone={(title) => {
            props.onEditTitle(null);
            if (title !== null) props.onRenameGroup(editingGroupId, title);
          }}
        />
      )}
      {(selectedIds.length > 1 || pickedGroup) && selection && !selection.held && host && (
        <SelectionToolbar
          around={selection.rect}
          area={{ width: host.offsetWidth, height: host.offsetHeight }}
          count={selectedIds.length}
          groups={props.selectionTools}
        />
      )}
      <ViewControls
        onZoomIn={() => boardRef.current?.zoomBy(1.25)}
        onZoomOut={() => boardRef.current?.zoomBy(0.8)}
        onFit={() => boardRef.current?.fitAll()}
      />
    </div>
  );
}

/**
 * A group's title being typed, in a text field laid exactly over the title on the board and set the same way,
 * so it reads as the heading being edited in place. Zoomed far out it stays big enough to type in. Enter or
 * clicking away keeps it; Esc goes back to what it was.
 */
function GroupTitleField({
  spot,
  title,
  onDone,
}: {
  spot: { rect: ScreenRect; fontSize: number };
  title: string;
  onDone(title: string | null): void;
}) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result === null || result.trim() === title ? null : result.trim());
  };
  const fontSize = Math.max(12, spot.fontSize);
  const height = Math.max(spot.rect.height, fontSize * 1.25);
  return (
    <input
      className="group-title-field"
      autoFocus
      value={value}
      placeholder="Group name"
      maxLength={200}
      spellCheck={false}
      style={{
        left: spot.rect.x,
        top: spot.rect.y + (spot.rect.height - height) / 2,
        width: Math.max(120, spot.rect.width),
        height,
        lineHeight: `${height}px`,
        fontSize,
      }}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value);
        else if (e.key === 'Escape') finish(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}
