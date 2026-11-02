import type { CaptureMode } from './messages';
import { ICONS } from './ui';

export interface Action {
  mode: CaptureMode;
  label: string;
  /** The Chrome command (wxt.config.ts) that runs it from the keyboard. */
  command: string;
  icon: string;
}

/**
 * What the toolbar popup and the floating button offer, in that order. Capture area comes last: it is the
 * fallback for what isn't an image (a page layout, a detail of a picture), so it has no key until the user picks one.
 */
export const ACTIONS: Action[] = [
  { mode: 'image', label: 'Save image', command: 'capture-image', icon: ICONS.image },
  { mode: 'video', label: 'Save video frame', command: 'capture-video-frame', icon: ICONS.video },
  { mode: 'page', label: 'Save page', command: 'bookmark-page', icon: ICONS.bookmark },
  { mode: 'area', label: 'Capture area', command: 'capture-area', icon: ICONS.area },
];
