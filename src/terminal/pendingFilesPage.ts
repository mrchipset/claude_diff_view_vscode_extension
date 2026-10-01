import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager, FileChangeSummary } from '../diff/diffManager';
import { ChangeGroup, formatBlockRange } from '../diff/hunkGroups';

export type SessionState = 'idle' | 'running' | 'error';

export interface PendingFilesContext {
  diffManager: DiffManager;
  iconBase: string;
  sessionState: SessionState;
  lastPrompt: string;
  errorMessage: string;
  /**
   * Tóm tắt thay đổi cho từng pending file, key = path y như getPendingFiles()
   * trả về. File thiếu entry vẫn hiển thị, chỉ không có +a/-r và danh sách khối.
   */
  changeSummaries: ReadonlyMap<string, FileChangeSummary>;
}

/** HTML inserted into #files-wrap. Pure function of the inputs above. */
export function buildPendingFilesInnerHtml(ctx: PendingFilesContext): string {
  const pending = ctx.diffManager.getPendingFiles();
  const treeModel = buildPendingTreeModel(pending, ctx.changeSummaries);
  const pendingTreeHtml =
    pending.length === 0 ? '' : renderPendingTreeHtml(treeModel, 0, ctx.iconBase);

  let statusHtml = '';
  if (ctx.sessionState === 'running') {
    statusHtml = `
      <div class="banner banner-run">
        <span class="banner-icon">&#8635;</span>
        <div class="banner-text">
          <div class="banner-title">Running</div>
          <div class="banner-detail">${escapeHtml(ctx.lastPrompt || '(no prompt)')}</div>
        </div>
      </div>`;
  } else if (ctx.sessionState === 'error') {
    statusHtml = `
      <div class="banner banner-err">
        <span class="banner-icon">&#9888;</span>
        <div class="banner-text">
          <div class="banner-title">Session failed</div>
          <div class="banner-detail">${escapeHtml(ctx.errorMessage || 'Unknown error')}</div>
        </div>
      </div>`;
  }

  const pendingBlock =
    pending.length === 0
      ? `<div class="empty-pending">No pending file changes</div>`
      : `
      <div class="section-title">
        <span>Pending changes</span>
        <span class="badge">${pending.length}</span>
      </div>
      <div class="file-tree" id="file-tree">${pendingTreeHtml}</div>`;

  return `
    <div class="scroll-region">
      ${statusHtml}
      <div class="section">
        ${pendingBlock}
      </div>
    </div>
  `;
}

/** CSS rules for the pending files page. Inlined into the unified webview's <style>. */
export const PENDING_FILES_CSS = `
  #files-wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 12px;
  }
  #files-wrap .scroll-region {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    user-select: none;
  }
  #files-wrap .banner {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.08));
  }
  #files-wrap .banner-run .banner-icon { color: var(--vscode-charts-yellow, #cca700); font-size: 16px; line-height: 1.2; }
  #files-wrap .banner-err {
    border-color: var(--vscode-inputValidation-errorBorder, rgba(241,76,76,0.45));
    background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,0.08));
  }
  #files-wrap .banner-err .banner-icon { color: var(--vscode-errorForeground, #f14c4c); }
  #files-wrap .banner-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.85; }
  #files-wrap .banner-detail { margin-top: 4px; font-size: 12px; line-height: 1.45; opacity: 0.95; word-break: break-word; }
  #files-wrap .section-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.75;
    margin-bottom: 6px;
  }
  #files-wrap .badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  #files-wrap .file-tree {
    display: flex;
    flex-direction: column;
    font-size: 13px;
    line-height: 22px;
    color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
  }
  #files-wrap .tree-node { outline: none; }
  #files-wrap .tree-node > .tree-row-folder { list-style: none; cursor: pointer; }
  #files-wrap .tree-node > .tree-row-folder::-webkit-details-marker { display: none; }
  #files-wrap .tree-node > .tree-row-folder::marker { content: ''; }
  #files-wrap .tree-row {
    display: flex;
    align-items: center;
    min-height: 22px;
    padding: 1px 4px;
    margin: 0;
    border: none;
    border-radius: 2px;
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    line-height: 22px;
    color: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
    box-sizing: border-box;
  }
  #files-wrap .tree-row:hover { background: var(--vscode-list-hoverBackground); }
  #files-wrap .tree-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  #files-wrap .tree-twist {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-right: 1px;
    color: var(--vscode-icon-foreground);
    opacity: 0.9;
  }
  #files-wrap .tree-twist-file { flex-shrink: 0; width: 16px; height: 16px; margin-right: 1px; }
  #files-wrap .tree-node:not([open]) .tree-chev-open { display: none !important; }
  #files-wrap .tree-node[open] .tree-chev-closed { display: none !important; }
  #files-wrap .tree-node:not([open]) .tree-ico-open { display: none !important; }
  #files-wrap .tree-node[open] .tree-ico-closed { display: none !important; }
  #files-wrap .tree-ico-slot {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    margin-right: 4px;
    color: var(--vscode-icon-foreground);
  }
  #files-wrap .tree-row-file .tree-ico-slot { opacity: 0.92; }
  #files-wrap .tree-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #files-wrap .tree-row-folder .tree-label { font-weight: 400; }
  #files-wrap .tree-children { display: block; }

  /* ---- Danh sách thay đổi (kiểu Copilot) ---- */
  #files-wrap .tree-node-file { display: block; }
  #files-wrap .tree-row-file { padding-left: 4px; }
  #files-wrap .tree-row-main {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    gap: 0;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    line-height: 22px;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  #files-wrap .tree-row-main:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  #files-wrap .tree-stats {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    flex-shrink: 0;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  #files-wrap .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
  #files-wrap .stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
  #files-wrap .tree-twist-btn {
    border: none;
    background: transparent;
    padding: 0;
    margin: 0;
    cursor: pointer;
    color: var(--vscode-icon-foreground);
  }
  #files-wrap .tree-twist-btn[aria-expanded="true"] .tree-chev-closed { display: none !important; }
  #files-wrap .tree-twist-btn[aria-expanded="false"] .tree-chev-open { display: none !important; }
  #files-wrap .change-list { display: block; }
  #files-wrap .change-list[hidden] { display: none; }
  #files-wrap .change-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 20px;
    line-height: 20px;
    padding-right: 4px;
    border-radius: 2px;
    font-size: 12px;
    cursor: pointer;
  }
  #files-wrap .change-row:hover { background: var(--vscode-list-hoverBackground); }
  #files-wrap .change-range {
    flex: 0 0 auto;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
  #files-wrap .change-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    flex-shrink: 0;
  }
  #files-wrap .change-btn {
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0 8px;
    height: 18px;
    font-family: var(--vscode-font-family);
    font-size: 11px;
    line-height: 16px;
    color: inherit;
    cursor: pointer;
  }
  #files-wrap .change-btn.keep { background: rgba(46, 160, 67, 0.35); }
  #files-wrap .change-btn.keep:hover { background: rgba(46, 160, 67, 0.6); }
  #files-wrap .change-btn.undo { background: rgba(248, 81, 73, 0.3); }
  #files-wrap .change-btn.undo:hover { background: rgba(248, 81, 73, 0.55); }
  #files-wrap .empty-pending { font-size: 12px; opacity: 0.45; font-style: italic; padding: 8px 0; }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

interface DirBuild {
  subdirs: Map<string, DirBuild>;
  files: TreeFile[];
}

interface TreeFile {
  name: string;
  path: string;
  added: number;
  removed: number;
  groups: ChangeGroup[];
}

interface TreeJson {
  dirs: Array<{ name: string; tree: TreeJson }>;
  files: TreeFile[];
}

function workspaceFolderContaining(absPath: string): vscode.WorkspaceFolder | undefined {
  const norm = path.normalize(absPath);
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const root = path.normalize(f.uri.fsPath);
    const rel = path.relative(root, norm);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return f;
    }
  }
  return undefined;
}

function commonPathPrefix(fullPaths: string[]): string {
  if (fullPaths.length === 0) {
    return '';
  }
  const split = fullPaths.map((p) =>
    path.normalize(p).split(path.sep).filter((s) => s.length > 0)
  );
  const first = split[0]!;
  let len = first.length;
  for (let i = 1; i < split.length; i++) {
    const row = split[i]!;
    let j = 0;
    while (j < len && j < row.length && first[j]!.toLowerCase() === row[j]!.toLowerCase()) {
      j++;
    }
    len = j;
  }
  if (len === 0) {
    return '';
  }
  return path.join(...first.slice(0, len));
}

function outsideBaseForOrphans(orphans: string[]): string {
  if (orphans.length === 0) {
    return '';
  }
  if (orphans.length === 1) {
    return path.dirname(path.normalize(orphans[0]!));
  }
  return commonPathPrefix(orphans.map((p) => path.normalize(p)));
}

function addToTree(root: DirBuild, parts: string[], file: TreeFile): void {
  if (parts.length === 1) {
    root.files.push(file);
    return;
  }
  const head = parts[0]!;
  const tail = parts.slice(1);
  let sub = root.subdirs.get(head);
  if (!sub) {
    sub = { subdirs: new Map(), files: [] };
    root.subdirs.set(head, sub);
  }
  addToTree(sub, tail, file);
}

function dirBuildToJson(db: DirBuild): TreeJson {
  const dirs = [...db.subdirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sub]) => ({ name, tree: dirBuildToJson(sub) }));
  const files = [...db.files].sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, files };
}
function buildPendingTreeModel(
  pending: string[],
  summaries: ReadonlyMap<string, FileChangeSummary>
): TreeJson {
  const root: DirBuild = { subdirs: new Map(), files: [] };
  const folders = vscode.workspace.workspaceFolders ?? [];
  const orphans = pending.filter((p) => !workspaceFolderContaining(p));
  const outsideBase = outsideBaseForOrphans(orphans);

  for (const absPath of pending) {
    const wf = workspaceFolderContaining(absPath);
    let parts: string[];
    if (wf) {
      const rel = path.relative(wf.uri.fsPath, path.normalize(absPath));
      const segments = rel.split(/[/\\]/).filter(Boolean);
      parts = folders.length > 1 ? [wf.name, ...segments] : segments;
    } else {
      const rel = path.relative(outsideBase, path.normalize(absPath));
      parts = rel.split(/[/\\]/).filter(Boolean).filter((seg) => seg !== '.' && seg !== '..');
      if (parts.length === 0) {
        parts = [path.basename(absPath)];
      }
    }
    if (parts.length) {
      const summary = summaries.get(absPath);
      addToTree(root, parts, {
        name: parts[parts.length - 1]!,
        path: absPath,
        added: summary ? summary.added : 0,
        removed: summary ? summary.removed : 0,
        groups: summary ? summary.groups : [],
      });
    }
  }
  return dirBuildToJson(root);
}

const EXT_ICON: Record<string, string> = {
  ts: 'typescript', tsx: 'react_ts',
  js: 'javascript', jsx: 'react',  mjs: 'javascript', cjs: 'javascript',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  html: 'html', htm: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c', cc: 'cpp', cpp: 'cpp', h: 'h', hpp: 'hpp',
  cs: 'csharp',
  sh: 'console', bash: 'console',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'svg',
  vue: 'vue',
  svelte: 'svelte',
  prisma: 'prisma',
  graphql: 'graphql',
  dockerfile: 'docker',
  env: 'document',
  gitignore: 'git',
  lock: 'lock',
  sql: 'database',
  zip: 'zip', gz: 'zip', tar: 'zip',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  pdf: 'pdf',
  txt: 'document',
};

function fileIconImg(fileName: string, iconBase: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const iconName = EXT_ICON[ext] ?? 'file';
  const src = escapeAttr(`${iconBase}${iconName}.svg`);
  return `<img src="${src}" width="16" height="16" aria-hidden="true" style="flex-shrink:0;display:block;">`;
}

function folderImg(open: boolean, iconBase: string): string {
  const name = open ? 'folder-open' : 'folder';
  const src = escapeAttr(`${iconBase}${name}.svg`);
  return `<img src="${src}" width="16" height="16" aria-hidden="true" style="flex-shrink:0;display:block;">`;
}

function chevronSvg(down: boolean): string {
  return down
    ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

function renderPendingTreeHtml(node: TreeJson, depth: number, iconBase: string): string {
  const indentPx = 2 + depth * 8;
  const chunks: string[] = [];
  for (const d of node.dirs) {
    const inner = renderPendingTreeHtml(d.tree, depth + 1, iconBase);
    chunks.push(
      `<details class="tree-node" open>` +
        `<summary class="tree-row tree-row-folder" style="padding-left:${indentPx}px">` +
        `<span class="tree-twist tree-chev-open">${chevronSvg(true)}</span>` +
        `<span class="tree-twist tree-chev-closed" style="display:none">${chevronSvg(false)}</span>` +
        `<span class="tree-ico-slot tree-ico-open">${folderImg(true, iconBase)}</span>` +
        `<span class="tree-ico-slot tree-ico-closed" style="display:none">${folderImg(false, iconBase)}</span>` +
        `<span class="tree-label">${escapeHtml(d.name)}</span>` +
        `</summary>` +
        `<div class="tree-children">${inner}</div>` +
        `</details>`
    );
  }
  for (const f of node.files) {
    chunks.push(renderPendingFileHtml(f, indentPx, iconBase));
  }
  return chunks.join('');
}

/** +/- badge cho một dòng file. Chỉ hiện khi thực sự có dòng thay đổi. */
function statsHtml(added: number, removed: number): string {
  if (added === 0 && removed === 0) { return ''; }
  const parts: string[] = [];
  if (added > 0) { parts.push(`<span class="stat stat-add">+${added}</span>`); }
  if (removed > 0) { parts.push(`<span class="stat stat-del">-${removed}</span>`); }
  return `<span class="tree-stats">${parts.join('')}</span>`;
}

/** Nhãn dòng của một khối: `L12`, hoặc `L12-14` khi khối thêm nhiều dòng liền nhau. */
function renderPendingFileHtml(f: TreeFile, indentPx: number, iconBase: string): string {
  const twisty = f.groups.length > 0
    ? `<button type="button" class="tree-twist tree-twist-btn" data-toggle-path="${escapeAttr(f.path)}" aria-expanded="false" aria-label="Toggle changes">` +
      `<span class="tree-chev-open">${chevronSvg(true)}</span>` +
      `<span class="tree-chev-closed">${chevronSvg(false)}</span>` +
      `</button>`
    : `<span class="tree-twist tree-twist-file" aria-hidden="true"></span>`;

  const blockRows = f.groups.map((g) =>
    `<div class="change-row" data-path="${escapeAttr(f.path)}" data-open-group="${escapeAttr(g.id)}" ` +
      `title="Open this change" style="padding-left:${indentPx + 22}px">` +
      `<span class="change-range">${escapeHtml(formatBlockRange(g))}</span>` +
      `<span class="change-actions">` +
      `<button type="button" class="change-btn undo" data-change-path="${escapeAttr(f.path)}" ` +
      `data-change-group="${escapeAttr(g.id)}" data-change-action="undo" title="Undo this change">Undo</button>` +
      `<button type="button" class="change-btn keep" data-change-path="${escapeAttr(f.path)}" ` +
      `data-change-group="${escapeAttr(g.id)}" data-change-action="keep" title="Keep this change">Keep</button>` +
      `</span>` +
      `</div>`
  ).join('');

  return (
    `<div class="tree-node-file">` +
      `<div class="tree-row tree-row-file" style="padding-left:${indentPx}px">` +
        twisty +
        `<button type="button" class="tree-row-main" data-path="${escapeAttr(f.path)}">` +
          `<span class="tree-ico-slot">${fileIconImg(f.name, iconBase)}</span>` +
          `<span class="tree-label">${escapeHtml(f.name)}</span>` +
          statsHtml(f.added, f.removed) +
        `</button>` +
      `</div>` +
      (blockRows ? `<div class="change-list" hidden>${blockRows}</div>` : '') +
    `</div>`
  );
}
