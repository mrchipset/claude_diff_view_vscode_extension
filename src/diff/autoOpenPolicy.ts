/**
 * autoOpenPolicy.ts
 *
 * Decides whether a diff tab may open by itself right after an external write is
 * detected.
 *
 * Kept separate from `WorkspaceWatcher` because the built-in Claude runner has to
 * follow the same rule — see `ai-cli-diff-view.autoOpenDiffMode`.
 *
 * Note that this only answers "may we open a tab?". Callers must register the
 * snapshot (`DiffManager.loadSnapshot`) first, so the file always lands in the
 * pending list and stays reachable via Alt+L / "Open Pending File".
 */

import * as path from 'path';
import * as vscode from 'vscode';

export type AutoOpenDiffMode = 'all' | 'alreadyOpen' | 'never';

export const AUTO_OPEN_DIFF_MODE_SETTING = 'ai-cli-diff-view.autoOpenDiffMode';

export const AUTO_OPEN_DIFF_MODES: readonly AutoOpenDiffMode[] = ['all', 'alreadyOpen', 'never'];

const CONFIG_SECTION = 'ai-cli-diff-view';
const DEFAULT_MODE: AutoOpenDiffMode = 'all';

let cachedMode: AutoOpenDiffMode = DEFAULT_MODE;

export function isAutoOpenDiffMode(value: unknown): value is AutoOpenDiffMode {
  return typeof value === 'string' && (AUTO_OPEN_DIFF_MODES as readonly string[]).includes(value);
}

/** Invalid or missing values fall back to `all`, i.e. the pre-setting behaviour. */
export function normalizeAutoOpenDiffMode(value: unknown): AutoOpenDiffMode {
  return isAutoOpenDiffMode(value) ? value : DEFAULT_MODE;
}

/** Call at activation and whenever `AUTO_OPEN_DIFF_MODE_SETTING` changes. */
export function refreshAutoOpenDiffMode(): void {
  cachedMode = normalizeAutoOpenDiffMode(
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('autoOpenDiffMode', DEFAULT_MODE)
  );
}

export function getAutoOpenDiffMode(): AutoOpenDiffMode {
  return cachedMode;
}

function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/**
 * Is the file currently open in a text editor tab?
 *
 * Only real text tabs are counted (`TabInputText` pointing at an on-disk file):
 * notebooks, this extension's own diff tabs and other schemes (`git:`,
 * `untitled:`…) are skipped because their `fsPath` is not a real file path.
 */
export function isOpenInTextEditor(filePath: string): boolean {
  const target = normalizePath(filePath);
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) { continue; }
      if (tab.input.uri.scheme !== 'file') { continue; }
      if (normalizePath(tab.input.uri.fsPath) === target) { return true; }
    }
  }
  return false;
}

/**
 * `true` when an external write should open a diff tab straight away.
 *
 * `never` / `alreadyOpen` do not mean "ignore the change" — the file is still
 * registered as pending, it just does not take over a tab and the user's focus.
 */
export function shouldAutoOpenDiff(filePath: string): boolean {
  if (cachedMode === 'all') { return true; }
  if (cachedMode === 'never') { return false; }
  return isOpenInTextEditor(filePath);
}
