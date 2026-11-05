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
  type Group,
  type GroupChange,
  type Item,
  type LayoutUpdate,
  type LibraryInfo,
  type LibraryProblem,
  type LibraryStatus,
  type OpenedLibrary,
  type SetupAction,
} from './api';
import { arrange, freeSpot, gather, type Arrangement, type Box } from './board/arrange';
import { GROUP_FRAME, groupFrame, isTyping, itemSize } from './board/Board';
import { BoardCanvas } from './components/BoardCanvas';
import { FloatingToolbar, type Tool } from './components/FloatingToolbar';
import type { IconName } from './components/Icon';
import { Inspector } from './components/Inspector';
import { LayoutSample } from './components/LayoutSample';
import { LibrarySetup } from './components/LibrarySetup';
import { ProblemCallout, countLabel } from './components/LibraryProblem';
import { Sidebar } from './components/Sidebar';
import { VaultGrid } from './components/VaultGrid';
import { History, type HistoryHooks } from './history';

/** One shared empty list, so a board waiting for its items doesn't see a new array on every render. */
const NO_ITEMS: BoardItem[] = [];
const NO_GROUPS: Group[] = [];

interface ArrangeChoice {
  kind: Arrangement;
  /** Shown on the Arrange button while this is the way it arranges. */
  icon: IconName;
  label: string;
  hint: string;
  done: string;
  already: string;
}

/** What the Arrange tool offers; the layouts themselves are in board/arrange.ts. */
const ARRANGEMENTS: ArrangeChoice[] = [
  { kind: 'tidy', icon: 'tidy', label: 'Tidy up', hint: 'Your layout, lined up', done: 'Tidied up', already: 'Already tidy' },
  { kind: 'grid', icon: 'grid', label: 'Grid', hint: 'Same-size cells in rows', done: 'Arranged in a grid', already: 'Already in a grid' },
  { kind: 'columns', icon: 'columns', label: 'Columns', hint: 'Same width, stacked in columns', done: 'Arranged in columns', already: 'Already in columns' },
];

/** Where this computer remembers which way Arrange lays things out. A preference of the app's, not the library's. */
const ARRANGEMENT_KEY = 'otterpocket.arrangement';

function storedArrangement(): Arrangement {
  try {
    const kind = localStorage.getItem(ARRANGEMENT_KEY);
    if (ARRANGEMENTS.some((choice) => choice.kind === kind)) return kind as Arrangement;
  } catch {
    // No storage (a private window, blocked site data): start from the first.
  }
  return 'tidy';
}

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
  // Arrange does this in one click; its menu picks another, which becomes the one.
  const [arrangement, setArrangement] = useState<Arrangement>(storedArrangement);
  const [groups, setGroups] = useState<Group[]>(NO_GROUPS);
  // The group whose title is being typed on the board.
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  // Which board `items` came from: right after a switch they still belong to the previous one.
  const [itemsBoardId, setItemsBoardId] = useState<string | null>(null);
  // In the order they were picked.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // The inspector opens on a click, not on every selection: pressing an item to drag it selects it too.
  const [inspecting, setInspecting] = useState(false);
  const [inspectorEl, setInspectorEl] = useState<HTMLElement | null>(null);
  const [grayscale, setGrayscale] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [libraryProblem, setLibraryProblem] = useState<LibraryProblem | null>(null);
  const [switching, setSwitching] = useState(false);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const showError = useCallback((message: string) => setToast({ message }), []);

  // One Undo history for the library while it is open (see history.ts). The hooks read this render's state.
  const historyHooks = useRef<HistoryHooks>(null!);
  const historyRef = useRef<History | null>(null);
  historyRef.current ??= new History({
    pushed: (step) => historyHooks.current.pushed(step),
    applied: (step, direction) => historyHooks.current.applied(step, direction),
    error: (message) => historyHooks.current.error(message),
  });
  const history = historyRef.current;

  // The inspector is about one reference. It closes when there isn't exactly one selected, so a selection that
  // isn't a click (a new save) doesn't reopen it.
  // The group picked by its band, so a group of one can be told from its one reference.
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const select = useCallback((itemIds: string[], groupId: string | null = null) => {
    setSelectedIds((current) => (current.length === itemIds.length && current.every((id, i) => id === itemIds[i]) ? current : itemIds));
    setPickedGroup(groupId);
    if (itemIds.length !== 1 || groupId) setInspecting(false);
  }, []);
  const inspect = useCallback(() => setInspecting(true), []);
  const closeInspector = useCallback(() => setInspecting(false), []);

  const loadCollections = useCallback(() => api.listCollections().then(setCollections, (e) => showError(String(e))), [showError]);

  const loadBoard = useCallback(
    (collectionId: string) =>
      Promise.all([api.listBoard(collectionId), collectionId === VAULT_ID ? NO_GROUPS : api.listGroups(collectionId)]).then(
        ([board, groups]) => {
          // Ignore answers for a board the user already navigated away from.
          if (collectionId !== activeIdRef.current) return;
          setItems(board);
          setGroups(groups);
          setItemsBoardId(collectionId);
        },
        (e) => showError(String(e)),
      ),
    [showError],
  );

  historyHooks.current = {
    // An Undo offered on a message is for the step it is about; once there's a newer one it would undo that.
    pushed: () => setToast((t) => (t?.undo ? null : t)),
    applied: (step, direction) => {
      setRevision((r) => r + 1);
      setToast({ message: `${direction === 'undo' ? 'Undone' : 'Redone'}: ${step.label}` });
      const back = step[direction].placements.flatMap((c) => (c.placement ? c.itemId : []));
      if (step.boardId === activeIdRef.current) {
        void loadBoard(step.boardId).then(() => select(back));
      } else {
        // Like a design app with pages: Undo shows the board it changes.
        setActiveId(step.boardId);
        if (back[0]) setReveal({ boardId: step.boardId, itemId: back[0] });
      }
    },
    error: showError,
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Text fields keep their own Undo.
      if (!(e.metaKey || e.ctrlKey) || e.code !== 'KeyZ' || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history]);

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
    setGroups(NO_GROUPS);
    setEditingGroupId(null);
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
      history.added(targetId, [itemId], 'Save from the web clipper');
      setRevision((r) => r + 1);
      setToast({ message: `New reference in ${targetName}`, collectionId: targetId, itemId });
    });
    return () => void unlisten.then((stop) => stop());
  }, [history, loadBoard, loadCollections]);

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

  /**
   * Takes references off the board on screen, without asking: replacing a reference with a better one is
   * routine, and Undo brings it back (the library keeps it until it is next opened).
   */
  const removeItems = async (targets: Item[]) => {
    if (targets.length === 0) return;
    const boardId = activeIdRef.current;
    let message: Toast | null = null;
    try {
      const { step } = await history.track(boardId, 'Remove', async () => {
        for (const item of targets) await api.removeFromCollection(item.id, boardId);
      });
      const what = targets.length === 1 ? '1 reference' : `${targets.length} references`;
      if (step) message = { message: `Removed ${what}`, undo: () => history.undoStep(step) };
    } catch (e) {
      // Some may be gone already; the board is reloaded below to show what's left.
      showError(String(e));
    }
    select([]);
    await loadBoard(boardId);
    setRevision((r) => r + 1);
    if (message) setToast(message);
  };

  /** Shows references where they're going straight away, ahead of the library saying they're there. */
  const placeLocally = (updates: LayoutUpdate[]) =>
    setItems((current) =>
      current.map((b) => {
        const u = updates.find((x) => x.itemId === b.item.id);
        return u ? { ...b, placement: { ...b.placement, x: u.x, y: u.y, scale: u.scale, z: u.z } } : b;
      }),
    );

  /** Moves, resizes or restacks references on the board on screen, as one step that Undo takes back. */
  const saveLayout = (updates: LayoutUpdate[], label = 'Move') => {
    const boardId = activeIdRef.current;
    placeLocally(updates);
    return history.track(boardId, label, () => api.saveLayout(boardId, updates)).then(
      ({ step }) => step,
      (e) => {
        showError(String(e));
        return null;
      },
    );
  };

  const boardItems = itemsBoardId === activeId ? items : NO_ITEMS;
  const boardGroups = itemsBoardId === activeId ? groups : NO_GROUPS;
  const membersOf = (groupId: string) => boardItems.filter((b) => b.placement.groupId === groupId).map((b) => b.item.id);
  const titleOf = (groupId: string) => boardGroups.find((g) => g.id === groupId)?.title ?? '';
  const named = (groupId: string) => `“${titleOf(groupId) || 'Untitled group'}”`;

  /**
   * Puts the board in order, or just `only` (the selection), keeping its top-left corner where it was. With
   * groups in it, each group is put in order inside, the chosen way, and so are the references outside
   * groups; then the groups and those references are lined up side by side the Tidy way, at their own size,
   * so a group is never shrunk into one cell. A selection that is exactly one group is arranged inside it.
   */
  const arrangeBoard = ({ kind, done, already }: ArrangeChoice, only?: string[]) => {
    const scope = only ? boardItems.filter((b) => only.includes(b.item.id)) : boardItems;
    const boxOf = ({ item, placement: p }: BoardItem): Box => {
      const { w, h } = itemSize(item);
      return { id: item.id, x: p.x, y: p.y, w: w * p.scale, h: h * p.scale };
    };
    const inGroup = new Map<string, Box[]>();
    for (const b of scope) {
      const g = b.placement.groupId;
      if (g) inGroup.set(g, [...(inGroup.get(g) ?? []), boxOf(b)]);
    }
    const groups = [...inGroup].filter(([g, members]) => members.length === membersOf(g).length && members.length < scope.length);
    let spots: Map<string, Box>;
    if (groups.length === 0) {
      spots = arrange(kind, scope.map(boxOf));
    } else {
      const grouped = new Set(groups.flatMap(([, members]) => members.map((m) => m.id)));
      const loose = scope.filter((b) => !grouped.has(b.item.id)).map(boxOf);
      // Each part laid out on its own first: every group, and (unless tidying) the references outside groups.
      const parts = groups.map(([g, members]) => ({ id: `group:${g}`, framed: true, spots: arrange(kind, members) }));
      if (loose.length > 0 && kind !== 'tidy') parts.push({ id: 'loose', framed: false, spots: arrange(kind, loose) });
      const units: Box[] = parts.map(({ id, framed, spots }) => {
        const inner = boundsOfBoxes([...spots.values()]);
        const f = framed ? groupFrame(inner) : inner;
        return { id, x: f.x, y: f.y, w: f.width, h: f.height };
      });
      // Tidying keeps references outside groups where they are, each lined up on its own.
      if (kind === 'tidy') units.push(...loose);
      const placed = arrange('tidy', units);
      spots = new Map(kind === 'tidy' ? loose.map((b) => [b.id, placed.get(b.id)!]) : []);
      parts.forEach((part, i) => {
        const from = units[i]!;
        const to = placed.get(part.id)!;
        for (const [id, s] of part.spots) spots.set(id, { ...s, x: s.x + to.x - from.x, y: s.y + to.y - from.y });
      });
    }
    const target = ({ item }: BoardItem) => {
      const spot = spots.get(item.id)!;
      return { x: spot.x, y: spot.y, scale: spot.w / itemSize(item).w };
    };
    const after: LayoutUpdate[] = [];
    for (const b of scope) {
      const p = b.placement;
      const { x, y, scale } = target(b);
      if (Math.abs(x - p.x) < 0.01 && Math.abs(y - p.y) < 0.01 && Math.abs(scale / p.scale - 1) < 1e-6) continue;
      after.push({ itemId: b.item.id, x, y, scale, z: p.z });
    }
    if (after.length === 0) return setToast({ message: already });
    void saveLayout(after, 'Arrange').then((step) => step && setToast({ message: done, undo: () => history.undoStep(step) }));
  };

  const usual = ARRANGEMENTS.find((choice) => choice.kind === arrangement) ?? ARRANGEMENTS[0];
  /** Arrange runs the usual way in one click; the arrow beside it picks another way, which becomes the usual one. */
  const arrangeTool = (id: string, only?: string[]): Tool => ({
    id,
    icon: usual.icon,
    label: `${only ? 'Arrange selected' : 'Arrange'}: ${usual.label}`,
    optionsLabel: 'Other ways to arrange',
    onClick: () => arrangeBoard(usual, only),
    options: ARRANGEMENTS.map((choice) => ({
      id: choice.kind,
      label: choice.label,
      hint: choice.hint,
      sample: <LayoutSample kind={choice.kind} />,
      current: choice.kind === usual.kind,
      onClick: () => {
        setArrangement(choice.kind);
        try {
          localStorage.setItem(ARRANGEMENT_KEY, choice.kind);
        } catch {
          // Kept for this session only.
        }
        arrangeBoard(choice, only);
      },
    })),
  });

  // ---- groups ----

  // What the selection has to do with the board's groups: exactly one whole group, or references shared
  // with one group (the update rule), or neither.
  const onBoard = new Map(boardItems.map((b) => [b.item.id, b]));
  const picked = selectedIds.filter((id) => onBoard.has(id));
  const pickedGroups = [...new Set(picked.flatMap((id) => onBoard.get(id)!.placement.groupId ?? []))];
  const sharedGroup = pickedGroups.length === 1 ? pickedGroups[0] : null;
  const wholeGroup =
    sharedGroup && picked.every((id) => onBoard.get(id)!.placement.groupId === sharedGroup) && membersOf(sharedGroup).length === picked.length
      ? sharedGroup
      : null;

  /**
   * Saves group changes (and moves that come with them) as one step, then says what changed with a way to
   * take it back.
   */
  const changeGroups = async (
    changes: GroupChange[],
    label: string,
    message: string | null,
    then?: (ids: string[]) => void,
    moves?: LayoutUpdate[],
  ) => {
    const boardId = activeIdRef.current;
    if (moves) placeLocally(moves);
    try {
      const { result: ids, step } = await history.track(boardId, label, async () => {
        if (moves) await api.saveLayout(boardId, moves);
        return api.saveGroups(boardId, changes);
      });
      await loadBoard(boardId);
      if (message && step) setToast({ message, undo: () => history.undoStep(step) });
      then?.(ids);
    } catch (e) {
      showError(String(e));
      await loadBoard(boardId);
    }
  };

  /**
   * Where a group's references go so that its frame holds nothing else: they stay put when it already doesn't
   * reach round other references or groups; otherwise they're dealt into a compact block from their top-left
   * corner, moved to the nearest clear spot when that's taken. `groupId` is the group they'll be (null for a new one).
   */
  const gatherMoves = (memberIds: string[], groupId: string | null): LayoutUpdate[] | undefined => {
    const members = new Set(memberIds);
    const boxOf = ({ item, placement: p }: BoardItem): Box => {
      const { w, h } = itemSize(item);
      return { id: item.id, x: p.x, y: p.y, w: w * p.scale, h: h * p.scale };
    };
    const mine = boardItems.filter((b) => members.has(b.item.id));
    // What the frame must stay clear of: references outside the group, and the frames of other groups as
    // they'll be afterwards.
    const obstacles: Box[] = [];
    const otherGroups = new Map<string, Box[]>();
    for (const b of boardItems) {
      if (members.has(b.item.id)) continue;
      const g = b.placement.groupId;
      if (g && g !== groupId) otherGroups.set(g, [...(otherGroups.get(g) ?? []), boxOf(b)]);
      else obstacles.push(boxOf(b));
    }
    for (const [g, boxes] of otherGroups) {
      const f = groupFrame(boundsOfBoxes(boxes));
      obstacles.push({ id: `group:${g}`, x: f.x, y: f.y, w: f.width, h: f.height });
    }
    const covers = (f: { x: number; y: number; width: number; height: number }) =>
      obstacles.some((o) => o.x < f.x + f.width && f.x < o.x + o.w && o.y < f.y + f.height && f.y < o.y + o.h);
    if (!covers(groupFrame(boundsOfBoxes(mine.map(boxOf))))) return undefined;

    const dealt = gather(mine.map(boxOf));
    const frame = groupFrame(boundsOfBoxes([...dealt.values()]));
    const spot = freeSpot(frame.width, frame.height, frame, obstacles, GROUP_FRAME.pad);
    return mine.map(({ item, placement: p }) => {
      const to = dealt.get(item.id)!;
      return { itemId: item.id, x: to.x + spot.x - frame.x, y: to.y + spot.y - frame.y, scale: p.scale, z: p.z };
    });
  };

  /**
   * ⌘G. Several references that share references with one group make that group exactly them, keeping its
   * title (the update rule); otherwise, or with `asNew`, they become a new group, leaving any groups they
   * were in. Scattered references are gathered (see gatherMoves). A new group's title is typed straight away.
   */
  const groupSelection = (asNew = false) => {
    if (picked.length < 2) return;
    if (sharedGroup && !asNew) {
      const was = new Set(membersOf(sharedGroup));
      const added = picked.filter((id) => !was.has(id)).length;
      const takenOut = [...was].filter((id) => !picked.includes(id)).length;
      if (added === 0 && takenOut === 0) return;
      const what = [added > 0 && `${added} added`, takenOut > 0 && `${takenOut} taken out`].filter(Boolean).join(', ');
      void changeGroups(
        [{ id: sharedGroup, title: titleOf(sharedGroup), itemIds: picked }],
        'Update group',
        `${named(sharedGroup)}: ${what}`,
        undefined,
        gatherMoves(picked, sharedGroup),
      );
      return;
    }
    void changeGroups(
      [{ id: null, title: '', itemIds: picked }],
      'Group',
      `Grouped ${picked.length} references`,
      ([id]) => setEditingGroupId(id),
      gatherMoves(picked, null),
    );
  };

  /** ⇧⌘G: takes the selected references out of their groups. A group selected whole is ungrouped. */
  const ungroupSelection = () => {
    const leaving = new Set(picked);
    const changes = pickedGroups.map((id) => ({ id, title: titleOf(id), itemIds: membersOf(id).filter((m) => !leaving.has(m)) }));
    if (changes.length === 0) return;
    const count = picked.filter((id) => onBoard.get(id)!.placement.groupId).length;
    const refs = count === 1 ? '1 reference' : `${count} references`;
    const message = wholeGroup
      ? `Ungrouped ${named(wholeGroup)}`
      : `Took ${refs} out of ${pickedGroups.length === 1 ? named(pickedGroups[0]) : 'their groups'}`;
    void changeGroups(changes, wholeGroup ? 'Ungroup' : 'Take out of group', message);
  };

  /** References dragged wholly out of their groups' frames leave them, in one step with the move. */
  const leaveGroups = (moves: LayoutUpdate[], itemIds: string[]) => {
    const leaving = new Set(itemIds);
    const from = [...new Set(itemIds.flatMap((id) => onBoard.get(id)?.placement.groupId ?? []))];
    if (from.length === 0) return void saveLayout(moves);
    const changes = from.map((id) => ({ id, title: titleOf(id), itemIds: membersOf(id).filter((m) => !leaving.has(m)) }));
    const refs = itemIds.length === 1 ? '1 reference' : `${itemIds.length} references`;
    const message = `Took ${refs} out of ${from.length === 1 ? named(from[0]) : 'their groups'}`;
    void changeGroups(changes, 'Take out of group', message, undefined, moves);
  };

  const renameGroup = (groupId: string, title: string) =>
    void changeGroups([{ id: groupId, title, itemIds: membersOf(groupId) }], 'Rename group', null);

  const groupTools: Tool[] = wholeGroup
    ? [
        { id: 'rename-group', icon: 'edit', text: titleOf(wholeGroup) || 'Untitled group', label: 'Rename group', onClick: () => setEditingGroupId(wholeGroup) },
        { id: 'ungroup', icon: 'ungroup', text: 'Ungroup', label: 'Ungroup', shortcut: '⇧⌘G', onClick: ungroupSelection },
      ]
    : sharedGroup
      ? [
          {
            id: 'update-group',
            text: `Update ${named(sharedGroup)}`,
            label: `Make ${named(sharedGroup)} exactly these references`,
            shortcut: '⌘G',
            onClick: () => groupSelection(),
          },
          { id: 'new-group', text: 'New group', label: 'Make a new group of these references', onClick: () => groupSelection(true) },
        ]
      : [{ id: 'group', icon: 'group', text: 'Group', label: 'Group these references', shortcut: '⌘G', onClick: () => groupSelection() }];

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
            history.keepOnly(new Set(list.map((c) => c.id)));
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
              items={boardItems}
              groups={boardGroups}
              editingGroupId={editingGroupId}
              selectedIds={selectedIds}
              pickedGroup={pickedGroup && pickedGroup === wholeGroup ? pickedGroup : null}
              grayscale={grayscale}
              reveal={revealHere}
              inspector={inspectorEl}
              selectionTools={selectedIds.length > 1 ? [groupTools, [arrangeTool('arrange-selection', selectedIds)]] : [groupTools]}
              onGroup={() => groupSelection()}
              onUngroup={ungroupSelection}
              onEditTitle={setEditingGroupId}
              onRenameGroup={renameGroup}
              onRevealed={revealed}
              onSelect={select}
              onInspect={inspect}
              onOpenSource={openSourceById}
              onRemove={(ids) => void removeItems(items.flatMap((b) => (ids.includes(b.item.id) ? [b.item] : [])))}
              onLayoutChange={saveLayout}
              onLeaveGroups={leaveGroups}
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
              onAddTo={(itemId, boardId) =>
                history
                  .track(boardId, `Add to “${collections.find((c) => c.id === boardId)?.name ?? 'board'}”`, () => api.addToCollection(itemId, boardId), {
                    adds: true,
                  })
                  .then(() => setRevision((r) => r + 1))
              }
              onError={showError}
              onClose={closeInspector}
            />
          )}
          <FloatingToolbar
            groups={[
              isVault
                ? []
                : [
                    arrangeTool('arrange'),
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

/** The box, in board units, around boxes given as x, y, w, h. */
function boundsOfBoxes(boxes: { x: number; y: number; w: number; h: number }[]) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
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
