import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { VAULT_ID, buildReturnUrl } from '@otterpocket/shared';
import {
  api,
  onLibraryChanged,
  type BoardItem,
  type BoardView,
  type Collection,
  type Item,
  type LayoutUpdate,
  type LibraryInfo,
  type LibraryProblem,
  type LibraryStatus,
  type OpenedLibrary,
  type SetupAction,
} from './api';
import { arrange, type Arrangement } from './board/arrange';
import { itemSize } from './board/Board';
import { BoardCanvas } from './components/BoardCanvas';
import { FloatingToolbar } from './components/FloatingToolbar';
import { Inspector } from './components/Inspector';
import { LayoutSample } from './components/LayoutSample';
import { LibrarySetup } from './components/LibrarySetup';
import { ProblemCallout, countLabel } from './components/LibraryProblem';
import { Sidebar } from './components/Sidebar';
import { VaultGrid } from './components/VaultGrid';

/** One shared empty list, so a board waiting for its items doesn't see a new array on every render. */
const NO_ITEMS: BoardItem[] = [];

interface ArrangeChoice {
  kind: Arrangement;
  label: string;
  hint: string;
  done: string;
  already: string;
}

/** What the Arrange tool offers; the layouts themselves are in board/arrange.ts. */
const ARRANGEMENTS: ArrangeChoice[] = [
  { kind: 'tidy', label: 'Tidy up', hint: 'Your layout, lined up', done: 'Tidied up', already: 'Already tidy' },
  { kind: 'grid', label: 'Grid', hint: 'Same-size cells in rows', done: 'Arranged in a grid', already: 'Already in a grid' },
  { kind: 'columns', label: 'Columns', hint: 'Same width, stacked in columns', done: 'Arranged in columns', already: 'Already in columns' },
];

interface Toast {
  message: string;
  collectionId?: string;
  /** The item the message is about, brought into view when the message is clicked. */
  itemId?: string;
  /** Takes back what the message is about. Only offered while the board it changed is on screen. */
  undo?: () => void;
}

/** A newly saved item to bring into view on its board. */
interface Reveal {
  boardId: string;
  itemId: string;
}

interface PendingRemoval {
  items: Item[];
  /** How many of them are on no other board, so removing them deletes them from the library. */
  deleting: number;
}

interface Notice {
  message: string;
}

/** Setup until a library is open, then the workspace for that library. */
export default function App() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    api.libraryStatus().then(setStatus, (e) => setFailure(String(e)));
  }, []);

  if (failure) return <div className="app-failure">{failure}</div>;
  if (!status) return null;
  if (status.state === 'setup') {
    return <LibrarySetup status={status} onReady={(library) => setStatus({ state: 'ready', library })} />;
  }
  return (
    <Workspace
      // A different library starts from a clean slate: no stale boards, selection or textures.
      key={status.library.root}
      library={status.library}
      notice={notice}
      onLibraryLost={setStatus}
      onLibraryOpened={(opened) => {
        setNotice({ message: openedMessage(opened, status.library) });
        setStatus({ state: 'ready', library: opened.library });
      }}
    />
  );
}

function openedMessage(opened: OpenedLibrary, previous: LibraryInfo): string {
  if (opened.library.root === previous.root) return 'That library is already open.';
  const message = opened.created
    ? `New library created in ${opened.library.displayPath}`
    : `Opened ${opened.library.displayPath} · ${countLabel(opened.stats.items, 'reference', 'references')}`;
  return opened.warning ? `${message}. ${opened.warning}` : message;
}

interface WorkspaceProps {
  library: LibraryInfo;
  notice: Notice | null;
  /** The library folder disappeared (moved, deleted, drive ejected) while the app was open. */
  onLibraryLost(status: LibraryStatus): void;
  onLibraryOpened(opened: OpenedLibrary): void;
}

function Workspace({ library, notice, onLibraryLost, onLibraryOpened }: WorkspaceProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeId, setActiveId] = useState(VAULT_ID);
  const [items, setItems] = useState<BoardItem[]>([]);
  // Which board `items` came from: right after a switch they still belong to the previous one.
  const [itemsBoardId, setItemsBoardId] = useState<string | null>(null);
  // In the order they were picked.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // The inspector opens on a click, not on every selection: pressing an item to drag it selects it too.
  const [inspecting, setInspecting] = useState(false);
  const [inspectorEl, setInspectorEl] = useState<HTMLElement | null>(null);
  const [grayscale, setGrayscale] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [libraryProblem, setLibraryProblem] = useState<LibraryProblem | null>(null);
  const [switching, setSwitching] = useState(false);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const showError = useCallback((message: string) => setToast({ message }), []);

  // The inspector is about one reference. It closes when there isn't exactly one selected, so a selection that
  // isn't a click (a new save) doesn't reopen it.
  const select = useCallback((itemIds: string[]) => {
    setSelectedIds((current) => (current.length === itemIds.length && current.every((id, i) => id === itemIds[i]) ? current : itemIds));
    if (itemIds.length !== 1) setInspecting(false);
  }, []);
  const inspect = useCallback(() => setInspecting(true), []);
  const closeInspector = useCallback(() => setInspecting(false), []);

  const loadCollections = useCallback(() => api.listCollections().then(setCollections, (e) => showError(String(e))), [showError]);

  const loadBoard = useCallback(
    (collectionId: string) =>
      api.listBoard(collectionId).then((board) => {
        // Ignore answers for a board the user already navigated away from.
        if (collectionId !== activeIdRef.current) return;
        setItems(board);
        setItemsBoardId(collectionId);
      }, (e) => showError(String(e))),
    [showError],
  );

  // Each board reopens where it was left: views from this session first, then what the library kept.
  // Panning fires constantly, so the library only hears about a view once it settles.
  const views = useRef(new Map<string, BoardView>());
  const unsavedViews = useRef(new Map<string, BoardView>());
  const viewTimer = useRef<number | undefined>(undefined);
  const flushViews = useCallback(() => {
    for (const [boardId, view] of unsavedViews.current) {
      api.setBoardView(boardId, view).catch((e) => console.warn('Could not keep the board view:', e));
    }
    unsavedViews.current.clear();
  }, []);
  const saveView = useCallback(
    (boardId: string, view: BoardView) => {
      views.current.set(boardId, view);
      unsavedViews.current.set(boardId, view);
      window.clearTimeout(viewTimer.current);
      viewTimer.current = window.setTimeout(flushViews, 600);
    },
    [flushViews],
  );
  useEffect(
    () => () => {
      window.clearTimeout(viewTimer.current);
      flushViews();
    },
    [flushViews],
  );

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    if (notice) setToast({ message: notice.message });
  }, [notice]);

  // Coming back to the app is when people have just moved or deleted the folder in Finder.
  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) return;
      api.libraryStatus().then((status) => {
        if (status.state !== 'ready') onLibraryLost(status);
      }, () => undefined);
    });
    return () => void unlisten.then((stop) => stop());
  }, [onLibraryLost]);

  useEffect(() => {
    select([]);
    setItems([]);
    setToast((t) => (t?.undo ? null : t));
    setReveal((r) => (r?.boardId === activeId ? r : null));
    void loadBoard(activeId);
  }, [activeId, loadBoard, select]);

  // Captures from the extension arrive while the app is open. One saved to the board on screen is brought
  // into view there; one saved elsewhere is shown when its message is clicked.
  useEffect(() => {
    const unlisten = onLibraryChanged(({ itemId, targetId, targetName }) => {
      void loadCollections();
      if (targetId === activeIdRef.current) {
        void loadBoard(targetId);
        setReveal({ boardId: targetId, itemId });
      }
      setRevision((r) => r + 1);
      setToast({ message: `New reference in ${targetName}`, collectionId: targetId, itemId });
    });
    return () => void unlisten.then((stop) => stop());
  }, [loadBoard, loadCollections]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.undo ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const active = collections.find((c) => c.id === activeId);
  const selectedItems = selectedIds.flatMap((id) => items.find((b) => b.item.id === id)?.item ?? []);
  const selected = selectedItems.length === 1 ? selectedItems[0] : null;
  const isVault = activeId === VAULT_ID;
  const revealHere = reveal?.boardId === activeId ? reveal : null;
  const revealed = (itemId: string) => setReveal((r) => (r?.itemId === itemId ? null : r));

  const openSource = (item: Item) => void openUrl(buildReturnUrl(item.source)).catch((e) => showError(String(e)));
  const openSourceById = (itemId: string) => {
    const item = items.find((b) => b.item.id === itemId)?.item;
    if (item) openSource(item);
  };

  /** Takes references off the board on screen. Asks first when that deletes any of them from the library. */
  const removeItems = async (targets: Item[], confirmed = false) => {
    if (targets.length === 0) return;
    const boardId = activeIdRef.current;
    if (!confirmed) {
      try {
        const boards = await Promise.all(targets.map((item) => api.itemCollections(item.id)));
        const deleting = boards.filter((b) => b.length <= 1).length;
        if (deleting > 0) return setPendingRemoval({ items: targets, deleting });
      } catch (e) {
        return showError(String(e));
      }
    }
    try {
      for (const item of targets) await api.removeFromCollection(item.id, boardId);
    } catch (e) {
      // Some may be gone already; the board is reloaded below to show what's left.
      showError(String(e));
    }
    setPendingRemoval(null);
    select([]);
    await loadBoard(boardId);
    setRevision((r) => r + 1);
  };

  const saveLayout = (updates: LayoutUpdate[]) => {
    const boardId = activeIdRef.current;
    setItems((current) =>
      current.map((b) => {
        const u = updates.find((x) => x.itemId === b.item.id);
        return u ? { ...b, placement: { ...b.placement, x: u.x, y: u.y, scale: u.scale, z: u.z } } : b;
      }),
    );
    api.saveLayout(boardId, updates).catch((e) => showError(String(e)));
  };

  /** Puts the board in order, or just `only` (the selection), which keeps its top-left corner where it was. */
  const arrangeBoard = ({ kind, done, already }: ArrangeChoice, only?: string[]) => {
    const all = itemsBoardId === activeId ? items : NO_ITEMS;
    const board = only ? all.filter((b) => only.includes(b.item.id)) : all;
    const spots = arrange(
      kind,
      board.map(({ item, placement: p }) => {
        const { w, h } = itemSize(item);
        return { id: item.id, x: p.x, y: p.y, w: w * p.scale, h: h * p.scale };
      }),
    );
    const before: LayoutUpdate[] = [];
    const after: LayoutUpdate[] = [];
    for (const { item, placement: p } of board) {
      const spot = spots.get(item.id)!;
      const scale = spot.w / itemSize(item).w;
      if (Math.abs(spot.x - p.x) < 0.01 && Math.abs(spot.y - p.y) < 0.01 && Math.abs(scale / p.scale - 1) < 1e-6) continue;
      const was = { itemId: item.id, x: p.x, y: p.y, scale: p.scale, z: p.z };
      before.push(was);
      after.push({ ...was, x: spot.x, y: spot.y, scale });
    }
    if (after.length === 0) return setToast({ message: already });
    saveLayout(after);
    setToast({ message: done, undo: () => saveLayout(before) });
  };

  const arrangeOptions = (only?: string[]) =>
    ARRANGEMENTS.map((choice) => ({
      id: choice.kind,
      label: choice.label,
      hint: choice.hint,
      sample: <LayoutSample kind={choice.kind} />,
      onClick: () => arrangeBoard(choice, only),
    }));

  const toggleOnTop = async () => {
    const next = !onTop;
    await getCurrentWindow().setAlwaysOnTop(next).catch((e) => showError(String(e)));
    setOnTop(next);
  };

  const revealLibrary = () => void api.revealInFolder(null).catch((e) => showError(String(e)));
  const revealItem = (item: Item) => item.asset && void api.revealInFolder(item.asset).catch((e) => showError(String(e)));

  const switchLibrary = async (action: SetupAction, force = false) => {
    if (switching) return;
    setSwitching(true);
    try {
      const result = await api.setupLibrary(action, force);
      if (result.outcome === 'problem') setLibraryProblem(result.problem);
      if (result.outcome === 'opened') {
        setLibraryProblem(null);
        onLibraryOpened(result);
      }
    } catch (e) {
      showError(String(e));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="app">
      <Sidebar
        collections={collections}
        activeId={activeId}
        library={library}
        onSelect={setActiveId}
        onChanged={loadCollections}
        onDeleted={(id) => {
          // The active project (or the folder it was in) may be gone; fall back to the Vault.
          void api.listCollections().then((list) => {
            if (!list.some((c) => c.id === activeIdRef.current) || id === activeIdRef.current) setActiveId(VAULT_ID);
          });
        }}
        onRevealLibrary={revealLibrary}
        onSwitchLibrary={(action) => void switchLibrary(action)}
        onError={showError}
      />

      <main className="main">
        <header className="toolbar" data-tauri-drag-region>
          <div className="toolbar-title" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{active?.name ?? 'Vault'}</h1>
            <span className="muted" data-tauri-drag-region>
              {items.length} {items.length === 1 ? 'reference' : 'references'}
              {selectedItems.length > 1 && ` · ${selectedItems.length} selected`}
            </span>
          </div>
        </header>

        <div className="content">
          {items.length === 0 && <EmptyState isVault={isVault} />}
          {isVault ? (
            <VaultGrid
              items={items}
              selectedId={selected?.id ?? null}
              reveal={revealHere?.itemId ?? null}
              onRevealed={revealed}
              onSelect={(id) => select(id ? [id] : [])}
              onInspect={inspect}
              onOpenSource={openSourceById}
            />
          ) : (
            <BoardCanvas
              boardId={activeId}
              view={views.current.get(activeId) ?? active?.view ?? null}
              items={itemsBoardId === activeId ? items : NO_ITEMS}
              selectedIds={selectedIds}
              grayscale={grayscale}
              fitSignal={fitSignal}
              reveal={revealHere}
              inspector={inspectorEl}
              selectionTools={[
                [{ id: 'arrange-selection', icon: 'arrange', label: 'Arrange selected', options: arrangeOptions(selectedIds) }],
              ]}
              onRevealed={revealed}
              onSelect={select}
              onInspect={inspect}
              onOpenSource={openSourceById}
              onRemove={(ids) => void removeItems(items.flatMap((b) => (ids.includes(b.item.id) ? [b.item] : [])))}
              onLayoutChange={saveLayout}
              onViewChange={saveView}
            />
          )}
          {selected && inspecting && (
            <Inspector
              ref={setInspectorEl}
              item={selected}
              activeId={activeId}
              collections={collections}
              revision={revision}
              onNotesSaved={() => void loadBoard(activeIdRef.current)}
              onOpenSource={openSource}
              onRemove={(item) => void removeItems([item])}
              onReveal={revealItem}
              onOpenBoard={setActiveId}
              onError={showError}
              onClose={closeInspector}
            />
          )}
          <FloatingToolbar
            groups={[
              isVault
                ? []
                : [
                    { id: 'fit', icon: 'fit', label: 'Fit everything', shortcut: 'F', onClick: () => setFitSignal((n) => n + 1) },
                    { id: 'arrange', icon: 'arrange', label: 'Arrange', options: arrangeOptions() },
                    {
                      id: 'grayscale',
                      icon: 'contrast',
                      label: 'Black & white value check',
                      pressed: grayscale,
                      onClick: () => setGrayscale((g) => !g),
                    },
                  ],
              [{ id: 'on-top', icon: 'pin', label: 'Keep window on top', pressed: onTop, onClick: () => void toggleOnTop() }],
            ]}
          >
            {toast && (
              <div
                className={`toast${toast.collectionId ? ' clickable' : ''}`}
                onClick={() => {
                  if (toast.collectionId) setActiveId(toast.collectionId);
                  if (toast.collectionId && toast.itemId) setReveal({ boardId: toast.collectionId, itemId: toast.itemId });
                  setToast(null);
                }}
              >
                {toast.message}
                {/* The click also reaches the toast, which closes it. */}
                {toast.undo && (
                  <button className="toast-action" onClick={toast.undo}>
                    Undo
                  </button>
                )}
              </div>
            )}
          </FloatingToolbar>
        </div>
      </main>

      {pendingRemoval && (
        <ConfirmRemoval
          removal={pendingRemoval}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => void removeItems(pendingRemoval.items, true)}
        />
      )}

      {libraryProblem && (
        <ProblemDialog
          problem={libraryProblem}
          busy={switching}
          onClose={() => setLibraryProblem(null)}
          onRetry={() => void switchLibrary({ kind: 'path', path: libraryProblem.path })}
          onForce={() => void switchLibrary({ kind: 'path', path: libraryProblem.path }, true)}
        />
      )}
    </div>
  );
}

function EmptyState({ isVault }: { isVault: boolean }) {
  return (
    <div className="empty-state">
      <h2>{isVault ? 'Your Vault is empty' : 'Nothing on this board yet'}</h2>
      <p>
        {isVault
          ? 'Keep the few things that truly inspire you: an artist, a photo, an article, a moment in a video. They stay here, with a link back to where you found them.'
          : 'Collect the final references for this project. Choose this project when saving from Chrome, or add items from your Vault.'}
      </p>
      <p className="muted">In Chrome: right-click an image or video → Save to Otter Pocket</p>
    </div>
  );
}

/**
 * While a dialog is up it hears every key first and nothing behind it hears any, so Escape can't also clear the
 * board's selection or close the inspector. Its keys read the latest handlers rather than listening anew on
 * each render: a listener added again mid-keypress (a re-render caused by another listener) is skipped.
 */
function useDialogKeys(keys: { Escape?(): void; Enter?(): void }) {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const action = e.key === 'Escape' || e.key === 'Enter' ? latest.current[e.key] : undefined;
      if (!action) return;
      // Enter would press the focused button as well.
      e.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function ConfirmRemoval({ removal, onCancel, onConfirm }: { removal: PendingRemoval; onCancel(): void; onConfirm(): void }) {
  useDialogKeys({ Escape: onCancel, Enter: onConfirm });

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{removalTitle(removal)}</h3>
        <p>{removalDetail(removal)}</p>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="danger solid" onClick={onConfirm} autoFocus>
            {removal.deleting === removal.items.length ? 'Delete' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

function removalTitle({ items, deleting }: PendingRemoval): string {
  if (items.length === 1) return `Delete “${items[0].title || items[0].source.pageTitle || 'this reference'}”?`;
  if (deleting === items.length) return `Delete ${items.length} references?`;
  return `Remove ${items.length} references from this board?`;
}

function removalDetail({ items, deleting }: PendingRemoval): string {
  if (items.length === 1) return "It isn't on any other board, so removing it deletes it and its image file from your library.";
  if (deleting === items.length) {
    return "They aren't on any other board, so removing them deletes them and their image files from your library.";
  }
  const kept = items.length - deleting;
  const deleted =
    deleting === 1
      ? "1 of them isn't on any other board, so it and its image file are deleted from your library."
      : `${deleting} of them aren't on any other board, so they and their image files are deleted from your library.`;
  return `${deleted} ${kept === 1 ? 'The other one is' : `The other ${kept} are`} only taken off this board.`;
}

interface ProblemDialogProps {
  problem: LibraryProblem;
  busy: boolean;
  onClose(): void;
  onRetry(): void;
  onForce(): void;
}

function ProblemDialog({ problem, busy, onClose, onRetry, onForce }: ProblemDialogProps) {
  useDialogKeys({ Escape: onClose });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <ProblemCallout problem={problem} busy={busy} onRetry={onRetry} onForce={onForce} />
        <div className="modal-actions">
          <button onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
