import { VAULT_ID } from '@otterpocket/shared';
import { api, type Group, type Placement, type PlacementChange } from './api';

/**
 * Undo and Redo for the whole library, like a design app's for a whole file: one list of steps, whichever
 * board each happened on. A step keeps, for the board it changed, every placement and group title it touched
 * as they were before and after, and going back or forward puts those back (`restore_board`). That covers
 * anything done to a board the same way: moving, arranging, grouping, removing, adding, a web clipper save.
 *
 * Removing a reference never deletes it straight away: the library keeps its record and file until it is next
 * opened (see `collect_orphans` in library.rs), so Undo can bring it back for as long as the app is open. The
 * history lives as long as the library is open, too.
 */

/** What a board holds: each item's placement and each group's title. */
interface BoardState {
  placements: Map<string, Placement>;
  groups: Map<string, string>;
}

interface Patch {
  placements: PlacementChange[];
  groups: Group[];
}

export interface Step {
  boardId: string;
  /** Says what the step did, after "Undone:" or "Redone:", e.g. "Move". */
  label: string;
  undo: Patch;
  redo: Patch;
  /** The references it changed, to select once it has been undone or redone. */
  itemIds: string[];
}

export interface HistoryHooks {
  /** A new step was taken: anything that offered to undo an older one should stop offering it. */
  pushed(step: Step): void;
  /** A step was undone or redone; the board it is on needs reloading. */
  applied(step: Step, direction: 'undo' | 'redo'): void;
  error(message: string): void;
}

/** How many steps back Undo can go. */
const LIMIT = 200;

export class History {
  private done: Step[] = [];
  private undone: Step[] = [];
  /** Everything runs one at a time, so a step's before and after can't take in another step's change. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private hooks: HistoryHooks) {}

  /**
   * Runs `action`, which changes `boardId`, and remembers what it changed as one step. Only `adds` actions may
   * put references on the board; others ignore new ones, which can only be web clipper saves landing meanwhile.
   */
  track<T>(
    boardId: string,
    label: string,
    action: () => Promise<T>,
    options: { adds?: boolean } = {},
  ): Promise<{ result: T; step: Step | null }> {
    return this.run(async () => {
      const before = await boardState(boardId);
      let result: T;
      try {
        result = await action();
      } catch (e) {
        // What it did change before it failed can still be undone.
        await this.after(boardId, label, before, options).catch(() => undefined);
        throw e;
      }
      return { result, step: await this.after(boardId, label, before, options) };
    });
  }

  private async after(boardId: string, label: string, before: BoardState, options: { adds?: boolean }) {
    const step = diff(boardId, label, before, await boardState(boardId), options.adds ?? false);
    if (step) this.push(step);
    return step;
  }

  /** References that just arrived on a board (a web clipper save) become a step: Undo takes them off again. */
  added(boardId: string, itemIds: string[], label: string): void {
    this.quietly(async () => {
      const after = await boardState(boardId);
      const before: BoardState = { placements: new Map(after.placements), groups: after.groups };
      for (const id of itemIds) before.placements.delete(id);
      const step = diff(boardId, label, before, after, true);
      if (step) this.push(step);
    });
  }

  undo(): void {
    this.quietly(() => this.move(this.done, this.undone, 'undo'));
  }

  redo(): void {
    this.quietly(() => this.move(this.undone, this.done, 'redo'));
  }

  /** Undo, but only while `step` is still the latest; for an Undo button on a message about that step. */
  undoStep(step: Step): void {
    this.quietly(async () => {
      if (this.done[this.done.length - 1] === step) await this.move(this.done, this.undone, 'undo');
    });
  }

  latest(): Step | undefined {
    return this.done[this.done.length - 1];
  }

  /** Drops the steps of boards that are gone (a deleted project), so Undo doesn't stop at them. */
  keepOnly(boardIds: Set<string>): void {
    this.done = this.done.filter((s) => boardIds.has(s.boardId));
    this.undone = this.undone.filter((s) => boardIds.has(s.boardId));
  }

  private push(step: Step) {
    this.done.push(step);
    if (this.done.length > LIMIT) this.done.shift();
    this.undone = [];
    this.hooks.pushed(step);
  }

  private async move(from: Step[], to: Step[], direction: 'undo' | 'redo') {
    const step = from.pop();
    if (!step) return;
    const patch = step[direction];
    try {
      await api.restoreBoard(step.boardId, patch.placements, patch.groups);
    } catch (e) {
      // Left out of both lists: trying it again would fail the same way.
      this.hooks.error(`Couldn't ${direction} “${step.label}”: ${String(e)}`);
      return;
    }
    to.push(step);
    this.hooks.applied(step, direction);
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Runs `task` in turn, saying so if it fails, for callers that don't wait for it. */
  private quietly(task: () => Promise<void>) {
    this.run(task).catch((e) => this.hooks.error(String(e)));
  }
}

async function boardState(boardId: string): Promise<BoardState> {
  const [items, groups] = await Promise.all([api.listBoard(boardId), boardId === VAULT_ID ? [] : api.listGroups(boardId)]);
  return {
    placements: new Map(items.map((b) => [b.item.id, b.placement])),
    groups: new Map(groups.map((g) => [g.id, g.title])),
  };
}

function samePlacement(a: Placement | undefined, b: Placement | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.scale === b.scale && a.z === b.z && a.addedAt === b.addedAt && (a.groupId ?? null) === (b.groupId ?? null);
}

/** The step from `before` to `after`, or null when nothing changed. */
function diff(boardId: string, label: string, before: BoardState, after: BoardState, adds: boolean): Step | null {
  const ids = new Set([...before.placements.keys(), ...after.placements.keys()]);
  const itemIds = [...ids].filter(
    (id) => !samePlacement(before.placements.get(id), after.placements.get(id)) && (adds || before.placements.has(id)),
  );
  const renamed = [...before.groups].filter(([id, title]) => after.groups.has(id) && after.groups.get(id) !== title).map(([id]) => id);
  if (itemIds.length === 0 && renamed.length === 0) return null;

  const patch = (state: BoardState): Patch => {
    const placements = itemIds.map((itemId) => ({ itemId, placement: state.placements.get(itemId) ?? null }));
    // The groups those placements are in, made again if they've gone, and any whose title changed.
    const groupIds = new Set([...placements.flatMap((c) => c.placement?.groupId ?? []), ...renamed]);
    const groups = [...groupIds].flatMap((id) => {
      const title = state.groups.get(id);
      return title === undefined ? [] : [{ id, title }];
    });
    return { placements, groups };
  };
  return { boardId, label, undo: patch(before), redo: patch(after), itemIds };
}
