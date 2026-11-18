// Types for publik-updater.cjs (the publik updater template, copied unchanged; see docs/updates.md).
import type { MenuItemConstructorOptions } from "electron";

export interface PublikUpdates {
  /** True only in a test build started with PUBLIK_UPDATER_TEST: the caller must start nothing else. */
  testHook: boolean;
  /** A manual check, with a dialog for its result. */
  checkNow(): void;
  /** The "Check for Updates…" menu item. */
  menuItem(): MenuItemConstructorOptions;
}

export function startUpdates(options: { slug: string; appName?: string; menu?: boolean }): PublikUpdates;

export const FEED_BASE: string;
