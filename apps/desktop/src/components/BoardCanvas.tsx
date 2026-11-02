import { useEffect, useRef, useState } from 'react';
import { formatTimestamp, siteName } from '@otterpocket/shared';
import { Board, isTyping, type ScreenRect } from '../board/Board';
import type { BoardItem, BoardView, LayoutUpdate } from '../api';
import { Favicon } from './Favicon';

interface Props {
  boardId: string;
  /** Where this board was left last time, or null to fit it to the screen. */
  view: BoardView | null;
  items: BoardItem[];
  selectedId: string | null;
  grayscale: boolean;
  fitSignal: number;
  /** A newly saved item to bring into view and select, once it is on this board. */
  reveal: { boardId: string; itemId: string } | null;
  onRevealed(itemId: string): void;
  onSelect(itemId: string | null): void;
  onOpenSource(itemId: string): void;
  onRemove(itemId: string): void;
  onLayoutChange(updates: LayoutUpdate[]): void;
  onViewChange(boardId: string, view: BoardView): void;
}

export function BoardCanvas(props: Props) {
  const { boardId, items, selectedId, grayscale, fitSignal, reveal } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<Board | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [badge, setBadge] = useState<ScreenRect | null>(null);

  useEffect(() => {
    const board = new Board({
      select: (id) => latest.current.onSelect(id),
      openSource: (id) => latest.current.onOpenSource(id),
      layoutChanged: (updates) => latest.current.onLayoutChange(updates),
      selectionMoved: setBadge,
      viewChanged: (boardId, view) => latest.current.onViewChange(boardId, view),
      revealed: (id) => latest.current.onRevealed(id),
    });
    boardRef.current = board;
    board.setItems(latest.current.items, latest.current.boardId, latest.current.view);
    board.select(latest.current.selectedId);
    board.setGrayscale(latest.current.grayscale);
    void board.init(hostRef.current!);
    return () => {
      board.destroy();
      boardRef.current = null;
    };
  }, []);

  // The view only matters when the board changes, so it is read from the latest props rather than a dependency.
  useEffect(() => boardRef.current?.setItems(items, boardId, latest.current.view), [items, boardId]);
  useEffect(() => boardRef.current?.select(selectedId), [selectedId]);
  useEffect(() => boardRef.current?.setGrayscale(grayscale), [grayscale]);
  useEffect(() => {
    if (fitSignal) boardRef.current?.fitAll();
  }, [fitSignal]);
  // After setItems, so a reveal that comes with a board switch is kept for the board it is for.
  useEffect(() => {
    if (reveal) boardRef.current?.reveal(reveal.boardId, reveal.itemId);
  }, [reveal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      const board = boardRef.current;
      const selected = latest.current.selectedId;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) latest.current.onRemove(selected);
      else if (e.key === 'f') board?.fitAll();
      else if (e.key === '=' || e.key === '+') board?.zoomBy(1.25);
      else if (e.key === '-') board?.zoomBy(0.8);
      else if (e.key === 'Escape') latest.current.onSelect(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selected = items.find((b) => b.item.id === selectedId)?.item;

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
    </div>
  );
}
