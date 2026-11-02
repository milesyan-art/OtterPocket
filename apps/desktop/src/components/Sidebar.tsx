import { useState, type ReactNode } from 'react';
import { VAULT_ID } from '@otterpocket/shared';
import { api, type Collection, type LibraryInfo, type SetupAction } from '../api';
import { CaptureStatus } from './CaptureStatus';
import { Icon } from './Icon';
import { LibraryMenu } from './LibraryMenu';

interface Props {
  collections: Collection[];
  activeId: string;
  library: LibraryInfo;
  onSelect(id: string): void;
  onChanged(): void;
  onDeleted(id: string): void;
  onRevealLibrary(): void;
  onSwitchLibrary(action: SetupAction): void;
  onError(message: string): void;
}

export function Sidebar(props: Props) {
  const { collections, activeId, library, onSelect, onChanged, onDeleted, onRevealLibrary, onSwitchLibrary, onError } = props;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const create = async (kind: 'project' | 'folder', parentId: string | null) => {
    try {
      const created = await api.createCollection(kind === 'project' ? 'Untitled project' : 'New folder', kind, parentId);
      if (parentId) setCollapsed((s) => new Set([...s].filter((id) => id !== parentId)));
      onChanged();
      setRenamingId(created.id);
      if (kind === 'project') onSelect(created.id);
    } catch (e) {
      onError(String(e));
    }
  };

  const rename = async (id: string, name: string) => {
    setRenamingId(null);
    if (!name.trim()) return;
    await api.renameCollection(id, name).then(onChanged, (e) => onError(String(e)));
  };

  const remove = async (id: string) => {
    setConfirmDeleteId(null);
    await api.deleteCollection(id).then(() => {
      onDeleted(id);
      onChanged();
    }, (e) => onError(String(e)));
  };

  const childrenOf = (parentId: string | null) =>
    collections.filter((c) => c.kind !== 'vault' && c.parentId === parentId);

  const renderTree = (parentId: string | null, depth: number): ReactNode =>
    childrenOf(parentId).map((c) => {
      const isFolder = c.kind === 'folder';
      const isOpen = !collapsed.has(c.id);
      return (
        <li key={c.id}>
          <div
            className={`row${c.id === activeId ? ' active' : ''}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => {
              if (isFolder) setCollapsed((s) => (s.has(c.id) ? new Set([...s].filter((x) => x !== c.id)) : new Set(s).add(c.id)));
              else onSelect(c.id);
            }}
            onDoubleClick={() => setRenamingId(c.id)}
          >
            {isFolder ? (
              <span className={`chevron${isOpen ? ' open' : ''}`}>
                <Icon name="chevron" size={12} />
              </span>
            ) : (
              <span className="chevron-spacer" />
            )}
            <Icon name={isFolder ? 'folder' : 'project'} size={15} />
            {renamingId === c.id ? (
              <input
                className="rename"
                autoFocus
                defaultValue={c.name}
                onFocus={(e) => e.target.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => rename(c.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenamingId(null);
                }}
              />
            ) : (
              <span className="row-name">{c.name}</span>
            )}
            {confirmDeleteId === c.id ? (
              <span className="row-actions visible" onClick={(e) => e.stopPropagation()}>
                <span className="confirm-label">Delete?</span>
                <button title="Delete" className="danger" onClick={() => remove(c.id)}>
                  <Icon name="check" size={13} />
                </button>
                <button title="Cancel" onClick={() => setConfirmDeleteId(null)}>
                  <Icon name="close" size={13} />
                </button>
              </span>
            ) : (
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                {isFolder && (
                  <button title="New project in this folder" onClick={() => create('project', c.id)}>
                    <Icon name="plus" size={13} />
                  </button>
                )}
                <button title="Rename" onClick={() => setRenamingId(c.id)}>
                  <Icon name="edit" size={13} />
                </button>
                <button title="Delete" onClick={() => setConfirmDeleteId(c.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </span>
            )}
          </div>
          {isFolder && isOpen && <ul>{renderTree(c.id, depth + 1)}</ul>}
        </li>
      );
    });

  const hasProjects = collections.some((c) => c.kind !== 'vault');

  return (
    <nav className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region />
      <div className="sidebar-scroll">
        <div className={`row vault-row${activeId === VAULT_ID ? ' active' : ''}`} onClick={() => onSelect(VAULT_ID)}>
          <Icon name="vault" size={16} />
          <span className="row-name">Vault</span>
        </div>
        <p className="sidebar-hint">What shaped your eye. Kept for good.</p>

        <div className="section-header">
          <span>Projects</span>
          <span className="section-actions">
            <button title="New folder" onClick={() => create('folder', null)}>
              <Icon name="folder" size={14} />
            </button>
            <button title="New project" onClick={() => create('project', null)}>
              <Icon name="plus" size={14} />
            </button>
          </span>
        </div>
        {hasProjects ? (
          <ul className="tree">{renderTree(null, 0)}</ul>
        ) : (
          <button className="empty-projects" onClick={() => create('project', null)}>
            <Icon name="plus" size={14} /> New project
          </button>
        )}
      </div>

      <footer className="sidebar-footer">
        <LibraryMenu library={library} onReveal={onRevealLibrary} onSwitch={onSwitchLibrary} />
        <CaptureStatus library={library} />
      </footer>
    </nav>
  );
}
