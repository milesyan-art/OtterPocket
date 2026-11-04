import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CaptureResponse, CollectionKind, ExtensionHello, ItemKind, SourceInfo } from '@otterpocket/shared';

export interface Collection {
  id: string;
  parentId: string | null;
  kind: CollectionKind;
  name: string;
  sortOrder: number;
  /** Where a project board was last looked at; null until someone pans or zooms it. */
  view: BoardView | null;
}

/** The point at the centre of the screen, in board units, and the zoom. */
export interface BoardView {
  x: number;
  y: number;
  zoom: number;
}

export interface Item {
  id: string;
  kind: ItemKind;
  title: string | null;
  why: string | null;
  /** Path relative to the library root. */
  asset: string | null;
  width: number | null;
  height: number | null;
  source: SourceInfo;
  createdAt: number;
}

export interface Placement {
  x: number;
  y: number;
  scale: number;
  z: number;
  addedAt: number;
  /** The titled group it is in on this board, if any. */
  groupId: string | null;
}

/** A titled group of references on a project board. Which references are in it is on their placements. */
export interface Group {
  id: string;
  title: string;
}

/** What a group should be after saving: exactly these references, under this title. No id makes a new group. */
export interface GroupChange {
  id: string | null;
  title: string;
  itemIds: string[];
}

export interface BoardItem {
  item: Item;
  placement: Placement;
}

/** One item's placement on a board as Undo or Redo puts it back; null takes it off the board. */
export interface PlacementChange {
  itemId: string;
  placement: Placement | null;
}

export interface LayoutUpdate {
  itemId: string;
  x: number;
  y: number;
  scale: number;
  z: number;
}

export interface LibraryInfo {
  root: string;
  /** "Documents › Otter Pocket" */
  displayPath: string;
  captureAddress: string;
  serverError: string | null;
}

/** The last time the Chrome extension got in touch (see `ExtensionTracker` in server.rs). */
export interface ExtensionContact {
  /** Milliseconds since the epoch. */
  at: number;
  /** null until the extension has checked in, e.g. when the first contact was a capture. */
  hello: ExtensionHello | null;
}

export interface LibraryStats {
  items: number;
  projects: number;
}

/** Why a library folder couldn't be opened (see `OpenProblem` in library.rs). */
export type LibraryProblem = { path: string; displayPath: string } & (
  | { code: 'not-found' }
  | { code: 'not-a-library' }
  | { code: 'too-new'; version: number }
  | { code: 'damaged'; detail: string }
  | { code: 'no-permission'; detail: string }
  | { code: 'in-use'; computer: string; lastSeen: number }
  | { code: 'other'; detail: string }
);

export type SetupStatus = {
  state: 'setup';
  /** null on first run; set when the remembered library couldn't be opened. */
  problem: LibraryProblem | null;
  defaultDisplayPath: string;
};

export type LibraryStatus = { state: 'ready'; library: LibraryInfo } | SetupStatus;

export type SetupAction = { kind: 'default' } | { kind: 'choose' } | { kind: 'open' } | { kind: 'path'; path: string };

export type OpenedLibrary = {
  outcome: 'opened';
  created: boolean;
  library: LibraryInfo;
  stats: LibraryStats;
  /** Set when the library opened but this computer couldn't remember where it is. */
  warning: string | null;
};

export type SetupResult = OpenedLibrary | { outcome: 'cancelled' } | { outcome: 'problem'; problem: LibraryProblem };

export const api = {
  libraryStatus: () => invoke<LibraryStatus>('library_status'),
  /** `force` opens a library that looks open on another computer. */
  setupLibrary: (action: SetupAction, force = false) => invoke<SetupResult>('setup_library', { action, force }),
  revealInFolder: (asset: string | null) => invoke<void>('reveal_in_folder', { asset }),
  openPrivacySettings: () => invoke<void>('open_privacy_settings'),
  listCollections: () => invoke<Collection[]>('list_collections'),
  createCollection: (name: string, kind: 'folder' | 'project', parentId: string | null) =>
    invoke<Collection>('create_collection', { name, kind, parentId }),
  renameCollection: (id: string, name: string) => invoke<void>('rename_collection', { id, name }),
  deleteCollection: (id: string) => invoke<void>('delete_collection', { id }),
  listBoard: (collectionId: string) => invoke<BoardItem[]>('list_board', { collectionId }),
  updateItemNotes: (id: string, title: string | null, why: string | null) =>
    invoke<void>('update_item_notes', { id, title, why }),
  itemCollections: (itemId: string) => invoke<string[]>('item_collections', { itemId }),
  addToCollection: (itemId: string, collectionId: string) =>
    invoke<void>('add_to_collection', { itemId, collectionId }),
  removeFromCollection: (itemId: string, collectionId: string) =>
    invoke<void>('remove_from_collection', { itemId, collectionId }),
  saveLayout: (collectionId: string, updates: LayoutUpdate[]) =>
    invoke<void>('save_layout', { collectionId, updates }),
  restoreBoard: (collectionId: string, placements: PlacementChange[], groups: Group[]) =>
    invoke<void>('restore_board', { collectionId, placements, groups }),
  setBoardView: (collectionId: string, view: BoardView) => invoke<void>('set_board_view', { collectionId, view }),
  listGroups: (collectionId: string) => invoke<Group[]>('list_groups', { collectionId }),
  /** Each change's group holds exactly its references afterwards; empty groups go. Returns the groups' ids. */
  saveGroups: (collectionId: string, changes: GroupChange[]) => invoke<string[]>('save_groups', { collectionId, changes }),
  extensionContact: () => invoke<ExtensionContact | null>('extension_contact'),
  /** The Mac webview hides the pointer after each key press the page handles; this brings it back. */
  showPointer: () => invoke<void>('show_pointer'),
};

/** Fired by the capture server when the extension saves something: which item, and on which board. */
export function onLibraryChanged(handler: (saved: CaptureResponse) => void): Promise<UnlistenFn> {
  return listen<CaptureResponse>('library-changed', (event) => handler(event.payload));
}

/** Fired by the capture server whenever the extension gets in touch. */
export function onExtensionSeen(handler: (contact: ExtensionContact) => void): Promise<UnlistenFn> {
  return listen<ExtensionContact>('extension-seen', (event) => handler(event.payload));
}

/** Fired when the capture server can't get its port (the error) or finally gets it (null). */
export function onServerStatus(handler: (error: string | null) => void): Promise<UnlistenFn> {
  return listen<string | null>('capture-server', (event) => handler(event.payload));
}

/** URL the webview can load a library image from (served by the `lib` protocol in lib.rs). */
export function assetUrl(asset: string): string {
  return convertFileSrc(asset, 'lib');
}
