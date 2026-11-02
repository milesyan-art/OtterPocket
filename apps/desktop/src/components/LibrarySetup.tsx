import { useState, type ReactNode } from 'react';
import {
  api,
  type LibraryInfo,
  type LibraryProblem,
  type LibraryStats,
  type OpenedLibrary,
  type SetupAction,
  type SetupStatus,
} from '../api';
import { Icon } from './Icon';
import { ProblemCallout, canRetry, countLabel, describeProblem, fileManager, isMac } from './LibraryProblem';

interface Props {
  status: SetupStatus;
  onReady(library: LibraryInfo): void;
}

/**
 * Shown until a library is open: first-run setup that explains where everything is kept, or, when the
 * library this computer remembers can't be opened, what happened and how to find it.
 */
export function LibrarySetup({ status, onReady }: Props) {
  const [view, setView] = useState<'welcome' | 'remembered'>(status.problem ? 'remembered' : 'welcome');
  const [problem, setProblem] = useState<LibraryProblem | null>(status.problem);
  // Whether `problem` is about the library this computer remembered (worded "your library"),
  // rather than a folder just picked.
  const [remembered, setRemembered] = useState(status.problem !== null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<OpenedLibrary | null>(null);

  const run = async (action: SetupAction, force = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.setupLibrary(action, force);
      if (result.outcome === 'opened') setOpened(result);
      if (result.outcome === 'problem') {
        setProblem(result.problem);
        setRemembered(action.kind === 'path' && action.path === status.problem?.path);
      }
    } catch (e) {
      setProblem({ code: 'other', detail: String(e), path: '', displayPath: '' });
    } finally {
      setBusy(false);
    }
  };

  // The same folder again (drive reconnected, access allowed, other computer quit), optionally forced.
  const retry = (p: LibraryProblem, force = false) => void run({ kind: 'path', path: p.path }, force);

  if (opened) return <Ready opened={opened} onStart={() => onReady(opened.library)} />;

  if (view === 'remembered' && problem) {
    const { title, body } = describeProblem(problem, remembered);
    const inUse = problem.code === 'in-use';
    // Moved or renamed: the library still exists somewhere, so the job is to find it.
    const lost = problem.code === 'not-found' || problem.code === 'not-a-library';
    const retryable = canRetry(problem, remembered);
    return (
      <Screen>
        <div className="setup-mark warn">
          <Icon name="alert" size={22} />
        </div>
        <div className="setup-heading">
          <h1>{title}</h1>
          <p className="setup-lead">{body}</p>
        </div>
        <div className="setup-buttons">
          {inUse ? (
            <button className="primary" onClick={() => retry(problem)} disabled={busy} autoFocus>
              Try again
            </button>
          ) : problem.code === 'no-permission' && isMac ? (
            <button className="primary" onClick={() => void api.openPrivacySettings()} autoFocus>
              Open Privacy Settings
            </button>
          ) : (
            <button className="primary" onClick={() => void run({ kind: 'open' })} disabled={busy} autoFocus>
              {busy ? 'Opening…' : lost ? 'Locate my library…' : 'Open another library…'}
            </button>
          )}
          {inUse && (
            <button className="secondary" onClick={() => retry(problem, true)} disabled={busy}>
              Open anyway
            </button>
          )}
          {!inUse && retryable && (
            <button className="secondary" onClick={() => retry(problem)} disabled={busy}>
              Try again
            </button>
          )}
        </div>
        <div className="setup-links">
          {(inUse || problem.code === 'no-permission') && (
            <>
              <button className="link" onClick={() => void run({ kind: 'open' })} disabled={busy}>
                Open another library…
              </button>
              <span aria-hidden>·</span>
            </>
          )}
          <button
            className="link"
            onClick={() => {
              setProblem(null);
              setRemembered(false);
              setView('welcome');
            }}
            disabled={busy}
          >
            Set up a new library instead
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="setup-mark">
        <Icon name="vault" size={22} />
      </div>
      <div className="setup-heading">
        <h1>Welcome to Otter Pocket</h1>
        <p className="setup-lead">Keep the references that matter, with a link back to where you found them.</p>
      </div>

      <section className="explainer" aria-label="Where your library is kept">
        <div className="explainer-tree">
          <div className="tree-line root">
            <Icon name="folder" size={15} />
            <span className="tree-name">{status.defaultDisplayPath}</span>
            <span className="tree-note">your library</span>
          </div>
          <div className="tree-line">
            <Icon name="file" size={14} />
            <span className="tree-name">library.db</span>
            <span className="tree-note">boards, notes, and where each reference came from</span>
          </div>
          <div className="tree-line">
            <Icon name="image" size={14} />
            <span className="tree-name">assets</span>
            <span className="tree-note">your saved images</span>
          </div>
        </div>
        <ul className="explainer-points">
          <li>
            <Icon name="lock" size={15} />
            <span>Everything stays in this one folder on your computer. No account, no cloud.</span>
          </li>
          <li>
            <Icon name="laptop" size={15} />
            <span>
              New computer? Copy the folder over, or keep it in iCloud Drive or Dropbox. Then install Otter Pocket and choose{' '}
              <b>Open an existing library</b>.
            </span>
          </li>
        </ul>
      </section>

      {problem && (
        <ProblemCallout
          problem={problem}
          remembered={remembered}
          busy={busy}
          onRetry={() => retry(problem)}
          onForce={() => retry(problem, true)}
        />
      )}

      <div className="setup-actions">
        <button className="primary large" onClick={() => void run({ kind: 'default' })} disabled={busy} autoFocus>
          {busy ? 'Setting up…' : 'Set up my library'}
        </button>
        <p className="setup-note">
          Uses {status.defaultDisplayPath}. If a library is already there, for example synced from another computer,
          Otter Pocket opens it.
        </p>
        <div className="setup-links">
          <button className="link" onClick={() => void run({ kind: 'choose' })} disabled={busy}>
            Choose another location…
          </button>
          <span aria-hidden>·</span>
          <button className="link" onClick={() => void run({ kind: 'open' })} disabled={busy}>
            Open an existing library…
          </button>
        </div>
      </div>
    </Screen>
  );
}

function Ready({ opened, onStart }: { opened: OpenedLibrary; onStart(): void }) {
  const { created, library, stats, warning } = opened;
  const [revealError, setRevealError] = useState<string | null>(null);
  return (
    <Screen>
      <div className="setup-mark ok">
        <Icon name="check" size={22} />
      </div>
      <div className="setup-heading">
        <h1>{created ? 'Your library is ready' : 'Welcome back'}</h1>
        <p className="setup-lead">
          {created ? 'Everything you save goes into this folder:' : `Opened your library${contents(stats)}.`}
        </p>
      </div>
      <div className="path-row">
        <Icon name="folder" size={16} />
        <span className="path-text" title={library.root}>
          {library.displayPath}
        </span>
        <button
          className="link"
          onClick={() => api.revealInFolder(null).catch((e) => setRevealError(String(e)))}
        >
          Show in {fileManager}
        </button>
      </div>
      {(warning || revealError) && <p className="setup-warning">{warning ?? revealError}</p>}
      <p className="setup-tip">
        To save from Chrome, right-click any image or video and choose <b>Save to Otter Pocket</b>.
      </p>
      <div className="setup-buttons">
        <button className="primary large" onClick={onStart} autoFocus>
          Start
        </button>
      </div>
    </Screen>
  );
}

/** " with 12 references and 3 projects", or nothing for an empty library. */
function contents({ items, projects }: LibraryStats): string {
  if (items === 0 && projects === 0) return '';
  const parts = [countLabel(items, 'reference', 'references')];
  if (projects > 0) parts.push(countLabel(projects, 'project', 'projects'));
  return ` with ${parts.join(' and ')}`;
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="setup">
      {/* The window has no title bar: this strip lets people drag it. */}
      <div className="setup-drag" data-tauri-drag-region />
      <div className="setup-card">{children}</div>
    </div>
  );
}
