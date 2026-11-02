import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ITEM_KIND_LABELS, formatTimestamp, siteName } from '@otterpocket/shared';
import { api, assetUrl, type Collection, type Item } from '../api';
import { Favicon } from './Favicon';
import { Icon } from './Icon';

interface Props {
  item: Item | null;
  activeId: string;
  collections: Collection[];
  /** Bumped by the parent whenever placements may have changed. */
  revision: number;
  onNotesSaved(): void;
  onOpenSource(item: Item): void;
  onRemove(item: Item): void;
  onReveal(item: Item): void;
  onOpenBoard(collectionId: string): void;
  onError(message: string): void;
}

export function Inspector({ item, ...rest }: Props) {
  if (!item) {
    return (
      <aside className="inspector">
        <div className="inspector-top" data-tauri-drag-region />
        <div className="inspector-empty">
          <p>Select a reference to see why you kept it and where it came from.</p>
          <ul>
            <li>
              In Chrome, right-click any image or video → <b>Save to Otter Pocket</b>
            </li>
            <li>
              <kbd>⌥</kbd>
              <kbd>⇧</kbd>
              <kbd>A</kbd>, then click an image to save it
            </li>
            <li>
              <kbd>⌥</kbd>
              <kbd>⇧</kbd>
              <kbd>S</kbd> saves the playing video's frame
            </li>
          </ul>
        </div>
      </aside>
    );
  }
  return <ItemInspector key={item.id} item={item} {...rest} />;
}

function ItemInspector({ item, activeId, collections, revision, onNotesSaved, onOpenSource, onRemove, onReveal, onOpenBoard, onError }: Props & { item: Item }) {
  const [title, setTitle] = useState(item.title ?? '');
  const [why, setWhy] = useState(item.why ?? '');
  const [placedIn, setPlacedIn] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.itemCollections(item.id).then(setPlacedIn, (e) => onError(String(e)));
  }, [item.id, revision]);

  const saveNotes = () => {
    if (title === (item.title ?? '') && why === (item.why ?? '')) return;
    api.updateItemNotes(item.id, title, why).then(onNotesSaved, (e) => onError(String(e)));
  };

  const addTo = (collectionId: string) => {
    setAdding(false);
    api.addToCollection(item.id, collectionId).then(
      () => api.itemCollections(item.id).then(setPlacedIn),
      (e) => onError(String(e)),
    );
  };

  const boards = collections.filter((c) => c.kind === 'vault' || c.kind === 'project');
  const folderOf = (board: Collection) => collections.find((f) => f.id === board.parentId && f.kind === 'folder')?.name;
  const onBoards = boards.filter((c) => placedIn.includes(c.id));
  const addable = boards.filter((c) => !placedIn.includes(c.id));
  const { source } = item;

  return (
    <aside className="inspector">
      <div className="inspector-top" data-tauri-drag-region />
      <div className="inspector-scroll">
        {item.asset ? (
          <img className="inspector-preview" src={assetUrl(item.asset)} alt="" />
        ) : (
          <div className="inspector-preview inspector-cover">
            <h3>{item.title || source.pageTitle || source.site || siteName(source.pageUrl)}</h3>
          </div>
        )}

        <div className="inspector-kind">
          <span className={`kind kind-${item.kind}`}>{ITEM_KIND_LABELS[item.kind]}</span>
          <span className="muted">Kept {new Date(item.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
        </div>

        {/* Anything else is named by its source. An artist's page title rarely says who they are. */}
        {item.kind === 'artist' && (
          <label className="field">
            <span>Artist</span>
            <input value={title} placeholder="Who is this?" onChange={(e) => setTitle(e.target.value)} onBlur={saveNotes} />
          </label>
        )}
        <WhyNote value={why} onChange={setWhy} onDone={saveNotes} />

        <section className="inspector-section">
          <h4>Source</h4>
          <div className="source-site">
            <Favicon url={source.faviconUrl} />
            <span>{source.site || siteName(source.pageUrl)}</span>
          </div>
          {source.pageTitle && <p className="source-title">{source.pageTitle}</p>}
          <button className="primary wide" onClick={() => onOpenSource(item)}>
            <Icon name="external" />
            {source.videoTime != null ? `Open at ${formatTimestamp(source.videoTime)}` : 'Open source'}
          </button>
          <div className="source-links">
            {source.originUrl && (
              <button className="link" onClick={() => openUrl(source.originUrl!)}>
                Original post ↗
              </button>
            )}
            {source.mediaUrl && !source.mediaUrl.startsWith('blob:') && (
              <button className="link" onClick={() => openUrl(source.mediaUrl!)}>
                File URL ↗
              </button>
            )}
          </div>
        </section>

        <section className="inspector-section">
          <h4>On boards</h4>
          <div className="board-list">
            {onBoards.map((board) => {
              const here = board.id === activeId;
              return (
                <button
                  key={board.id}
                  className={`board-row${here ? ' current' : ''}`}
                  disabled={here}
                  title={here ? undefined : `Go to ${board.name}`}
                  onClick={() => onOpenBoard(board.id)}
                >
                  <BoardTile board={board} />
                  <span className="board-row-name">{board.name}</span>
                  {here ? <span className="board-row-hint">This board</span> : <Icon name="chevron" size={14} />}
                </button>
              );
            })}
            {addable.length > 0 && (
              <button className="board-row add" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
                <span className="board-tile">
                  <Icon name="plus" size={14} />
                </span>
                <span className="board-row-name">Add to a board</span>
              </button>
            )}
            {adding &&
              addable.map((board) => (
                <button key={board.id} className="board-row candidate" onClick={() => addTo(board.id)}>
                  <BoardTile board={board} />
                  <span className="board-row-name">{board.name}</span>
                  {folderOf(board) && <span className="board-row-hint">{folderOf(board)}</span>}
                  <Icon name="plus" size={14} />
                </button>
              ))}
          </div>
        </section>

        <section className="inspector-section actions">
          {item.asset && (
            <button onClick={() => onReveal(item)}>
              <Icon name="finder" /> Show file in Finder
            </button>
          )}
          <button className="danger" onClick={() => onRemove(item)}>
            <Icon name="trash" /> Remove from this board
          </button>
        </section>
      </div>
    </aside>
  );
}

function BoardTile({ board }: { board: Collection }) {
  return (
    <span className="board-tile">
      <Icon name={board.kind === 'vault' ? 'vault' : 'project'} size={14} />
    </span>
  );
}

/** Why you kept it. Optional, so it stays one quiet line until there's something to say. */
function WhyNote({ value, onChange, onDone }: { value: string; onChange(value: string): void; onDone(): void }) {
  const [editing, setEditing] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Grows with the note instead of scrolling inside a box.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
  }, [value, editing]);

  // Ready to add a thought after what's already there.
  useEffect(() => {
    const field = fieldRef.current;
    if (!editing || !field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={fieldRef}
        className="why-field"
        aria-label="Why it matters"
        value={value}
        rows={1}
        placeholder="What about this hits you? What could it become?"
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          setEditing(false);
          onDone();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      />
    );
  }
  if (value.trim()) {
    return (
      <button className="why-note" aria-label="Edit why it matters" onClick={() => setEditing(true)}>
        {value}
      </button>
    );
  }
  return (
    <button className="why-add" onClick={() => setEditing(true)}>
      <Icon name="edit" size={13} />
      Note why it matters
    </button>
  );
}
