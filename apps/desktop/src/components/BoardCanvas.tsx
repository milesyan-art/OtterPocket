import { useEffect, useRef, useState } from 'react';
import { formatTimestamp, siteName } from '@otterpocket/shared';
import { Board, isTyping, type ScreenRect } from '../board/Board';
import type { BoardItem, BoardView, LayoutUpdate } from '../api';
import { Favicon } from './Favicon';
import type { Tool } from './FloatingToolbar';
import { SelectionToolbar } from './SelectionToolbar';

interface Props {
  boardId: string;
  /** Where this board was left last time, or null to fit it to the screen. */
  view: BoardView | null;
  items: BoardItem[];
  /** In the order they were picked. */
  selectedIds: string[];
  grayscale: boolean;
  fitSignal: number;
  /** A newly saved item to bring into view and select, once it is on this board. */
  reveal: { boardId: string; itemId: string } | null;
  /** The floating inspector while it is open over the board, so what's selected can be kept out from under it. */
  inspector: HTMLElement | null;
  /** What can be done to several selected references at once, floating by them. */
  selectionTools: Tool[][];
  onRevealed(itemId: string): void;
  onSelect(itemIds: string[]): void;
  /** A click on an item, as opposed to a press that drags it or Shift or ⌘ that adds it to the selection. */
  onInspect(itemId: string): void;
  onOpenSource(itemId: string): void;
  onRemove(itemIds: string[]): void;
  onLayoutChange(updates: LayoutUpdate[]): void;
  onViewChange(boardId: string, view: BoardView): void;
}

export function BoardCanvas(props: Props) {
  const { boardId, items, selectedIds, grayscale, fitSignal, reveal, inspector } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<Board | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Where the selection is on screen, and whether it is being dragged.
  const [selection, setSelection] = useState<{ rect: ScreenRect; held: boolean } | null>(null);

  useEffect(() => {
    const board = new Board({
      select: (ids) => latest.current.onSelect(ids),
      clicked: (id) => latest.current.onInspect(id),
      openSource: (id) => latest.current.onOpenSource(id),
      layoutChanged: (updates) => latest.current.onLayoutChange(updates),
      selectionMoved: (rect, held) => setSelection(rect && { rect, held }),
      viewChanged: (boardId, view) => latest.current.onViewChange(boardId, view),
      revealed: (id) => latest.current.onRevealed(id),
    });
    boardRef.current = board;
    board.setItems(latest.current.items, latest.current.boardId, latest.current.view);
    board.select(latest.current.selectedIds);
    board.setGrayscale(latest.current.grayscale);
    void board.init(hostRef.current!);
    return () => {
      board.destroy();
      boardRef.current = null;
    };
  }, []);

  // The view only matters when the board changes, so it is read from the latest props rather than a dependency.
  useEffect(() => boardRef.current?.setItems(items, boardId, latest.current.view), [items, boardId]);
  useEffect(() => boardRef.current?.select(selectedIds), [selectedIds]);
  useEffect(() => boardRef.current?.setGrayscale(grayscale), [grayscale]);
  // Both sit in the same box, so the panel's distance from the right is in the canvas's terms. Offsets, not
  // rects, so the panel's opening animation doesn't skew it.
  useEffect(() => {
    const host = hostRef.current;
    boardRef.current?.setCoveredRight(inspector && host ? host.offsetWidth - inspector.offsetLeft : 0);
  }, [inspector]);
  useEffect(() => {
    if (fitSignal) boardRef.current?.fitAll();
  }, [fitSignal]);
  // After setItems, so a reveal that comes with a board switch is kept for the board it is for.
  useEffect(() => {
    if (reveal) boardRef.current?.reveal(reveal.boardId, reveal.itemId);
  }, [reveal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const board = boardRef.current;
      const { items, selectedIds, onSelect, onRemove } = latest.current;
      if (e.metaKey || e.ctrlKey) {
        if (e.key !== 'a') return;
        onSelect(items.map((b) => b.item.id));
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

  // The source badge is for one reference at a time; the selection's tools for several.
  const selected = selectedIds.length === 1 ? items.find((b) => b.item.id === selectedIds[0])?.item : undefined;
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
      {selectedIds.length > 1 && selection && !selection.held && host && (
        <SelectionToolbar
          around={selection.rect}
          area={{ width: host.offsetWidth, height: host.offsetHeight }}
          count={selectedIds.length}
          groups={props.selectionTools}
        />
      )}
    </div>
  );
}
