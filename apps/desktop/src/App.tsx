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
import { GROUP_FRAME, groupFrame, itemSize } from './board/Board';
import { BoardCanvas } from './components/BoardCanvas';
import { FloatingToolbar, type Tool } from './components/FloatingToolbar';
import type { IconName } from './components/Icon';
import { Inspector } from './components/Inspector';
import { LayoutSample } from './components/LayoutSample';
import { LibrarySetup } from './components/LibrarySetup';
import { ProblemCallout, countLabel } from './components/LibraryProblem';
import { Sidebar } from './components/Sidebar';
import { VaultGrid } from './components/VaultGrid';

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

/** References moved along with a group change, and where they were, for Undo. */
interface Moves {
  before: LayoutUpdate[];
  after: LayoutUpdate[];
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
    return api.saveLayout(boardId, updates).catch((e) => showError(String(e)));
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
    const before: LayoutUpdate[] = [];
    const after: LayoutUpdate[] = [];
    for (const b of scope) {
      const p = b.placement;
      const { x, y, scale } = target(b);
      if (Math.abs(x - p.x) < 0.01 && Math.abs(y - p.y) < 0.01 && Math.abs(scale / p.scale - 1) < 1e-6) continue;
      const was = { itemId: b.item.id, x: p.x, y: p.y, scale: p.scale, z: p.z };
      before.push(was);
      after.push({ ...was, x, y, scale });
    }
    if (after.length === 0) return setToast({ message: already });
    saveLayout(after);
    setToast({ message: done, undo: () => saveLayout(before) });
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
   * Saves group changes, then says what changed with a way to take it back. Undo puts back every group the
   * changes touched: the changed ones, and any that lost references to them.
   */
  const changeGroups = async (
    changes: GroupChange[],
    message: string | null,
    then?: (ids: string[]) => void,
    layout?: Moves,
  ) => {
    const boardId = activeIdRef.current;
    const moving = new Set(changes.flatMap((c) => c.itemIds));
    const touched = new Set([
      ...changes.flatMap((c) => c.id ?? []),
      ...boardItems.flatMap((b) => (moving.has(b.item.id) ? (b.placement.groupId ?? []) : [])),
    ]);
    const before: GroupChange[] = [...touched].map((id) => ({ id, title: titleOf(id), itemIds: membersOf(id) }));
    try {
      if (layout) await saveLayout(layout.after);
      const ids = await api.saveGroups(boardId, changes);
      // A new group wasn't there before: taking it back empties it, which removes it.
      changes.forEach((c, i) => c.id === null && before.push({ id: ids[i], title: '', itemIds: [] }));
      await loadBoard(boardId);
      const undo = async () => {
        if (layout) await saveLayout(layout.before);
        await api.saveGroups(boardId, before).then(() => loadBoard(boardId), (e) => showError(String(e)));
      };
      if (message) setToast({ message, undo: () => void undo() });
      then?.(ids);
    } catch (e) {
      showError(String(e));
    }
  };

  /**
   * Where a group's references go so that its frame holds nothing else: they stay put when it already doesn't
   * reach round other references or groups; otherwise they're dealt into a compact block from their top-left
   * corner, moved to the nearest clear spot when that's taken. `groupId` is the group they'll be (null for a new one).
   */
  const gatherMoves = (memberIds: string[], groupId: string | null): Moves | undefined => {
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
    const before: LayoutUpdate[] = [];
    const after: LayoutUpdate[] = [];
    for (const { item, placement: p } of mine) {
      const to = dealt.get(item.id)!;
      const was = { itemId: item.id, x: p.x, y: p.y, scale: p.scale, z: p.z };
      before.push(was);
      after.push({ ...was, x: to.x + spot.x - frame.x, y: to.y + spot.y - frame.y });
    }
    return { before, after };
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
        `${named(sharedGroup)}: ${what}`,
        undefined,
        gatherMoves(picked, sharedGroup),
      );
      return;
    }
    void changeGroups(
      [{ id: null, title: '', itemIds: picked }],
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
    void changeGroups(changes, message);
  };

  const renameGroup = (groupId: string, title: string) =>
    void changeGroups([{ id: groupId, title, itemIds: membersOf(groupId) }], null);

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
              grayscale={grayscale}
              fitSignal={fitSignal}
              reveal={revealHere}
              inspector={inspectorEl}
              selectionTools={[
                groupTools,
                [arrangeTool('arrange-selection', selectedIds)],
              ]}
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
