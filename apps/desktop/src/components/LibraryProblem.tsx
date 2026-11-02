import { api, type LibraryProblem } from '../api';
import { Icon } from './Icon';

export const isMac = navigator.userAgent.includes('Mac');
export const fileManager = isMac ? 'Finder' : 'File Explorer';

/**
 * What went wrong, in plain words. `remembered` means it's the library this computer opened last time
 * (so "it moved" is the likely story), rather than a folder the user just picked.
 */
export function describeProblem(problem: LibraryProblem, remembered: boolean): { title: string; body: string } {
  const where = problem.displayPath;
  switch (problem.code) {
    case 'not-found':
    case 'not-a-library':
      if (remembered) {
        return {
          title: "Can't find your library",
          body: `Otter Pocket keeps everything in one folder, last seen at ${where}. If you moved or renamed it, show Otter Pocket where it is now. If it's on an external drive, connect the drive and try again.`,
        };
      }
      return problem.code === 'not-found'
        ? { title: "That folder isn't there anymore", body: `${where} was moved or deleted.` }
        : {
            title: "That folder isn't an Otter Pocket library",
            body: 'A library folder has a file named library.db and a folder named assets inside. Choose that folder, usually Documents › Otter Pocket.',
          };
    case 'too-new':
      return {
        title: 'This library needs a newer Otter Pocket',
        body: `${where} was last used with a newer version of Otter Pocket. Update Otter Pocket on this computer to open it. Nothing in the library was changed.`,
      };
    case 'damaged':
      return {
        title: "This library can't be read",
        body: `The library.db file in ${where} looks damaged, so Otter Pocket left it untouched. If you have a backup (Time Machine, iCloud Drive, Dropbox), restore the folder and try again.`,
      };
    case 'no-permission':
      return isMac
        ? {
            title: "Otter Pocket isn't allowed to use this folder",
            body: `macOS is blocking access to ${where}. Open System Settings › Privacy & Security › Files & Folders, turn on access for Otter Pocket, then try again.`,
          }
        : {
            title: "Otter Pocket can't use this folder",
            body: `Windows didn't let Otter Pocket read and write ${where}. Choose a folder you own, such as Documents.`,
          };
    case 'in-use':
      return {
        title: `This library is open on “${problem.computer}”`,
        body: `It was in use ${timeAgo(problem.lastSeen)}. Using one library on two computers at the same time can damage it, so quit Otter Pocket there first. If that computer is off, or Otter Pocket crashed there, open it anyway.`,
      };
    case 'other':
      return { title: "Couldn't open the library", body: problem.detail };
  }
}

/** Whether trying the same folder again can help (after reconnecting a drive, allowing access, …). */
export function canRetry(problem: LibraryProblem, remembered: boolean): boolean {
  if (problem.code === 'too-new') return false;
  if (problem.code === 'not-a-library') return remembered;
  return problem.path !== '';
}

interface CalloutProps {
  problem: LibraryProblem;
  remembered?: boolean;
  busy?: boolean;
  onRetry?(): void;
  /** In use elsewhere: open it anyway. */
  onForce?(): void;
}

/** A problem shown in place: inline on the setup screen, or in a dialog over the app. */
export function ProblemCallout({ problem, remembered = false, busy = false, onRetry, onForce }: CalloutProps) {
  const { title, body } = describeProblem(problem, remembered);
  const showPrivacy = problem.code === 'no-permission' && isMac;
  const showRetry = onRetry && canRetry(problem, remembered);
  const showForce = onForce && problem.code === 'in-use';
  return (
    <div className="problem" role="alert">
      <span className="problem-icon">
        <Icon name="alert" size={17} />
      </span>
      <div className="problem-text">
        <h3>{title}</h3>
        <p>{body}</p>
        {(showPrivacy || showRetry || showForce) && (
          <div className="problem-actions">
            {showPrivacy && <button onClick={() => void api.openPrivacySettings()}>Open Privacy Settings</button>}
            {showRetry && (
              <button onClick={onRetry} disabled={busy}>
                Try again
              </button>
            )}
            {showForce && (
              <button className="quiet" onClick={onForce} disabled={busy}>
                Open anyway
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function timeAgo(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
