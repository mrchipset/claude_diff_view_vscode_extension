import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager, FileChangeSummary } from '../diff/diffManager';
import { formatBlockRange } from '../diff/hunkGroups';

export interface NavInfo {
  currentIdx: number;
  total: number;
  prevName: string;
  nextName: string;
  canPrev: boolean;
  canNext: boolean;
}

/** Map extension → material-icon-theme SVG filename */
const EXT_ICON: Record<string, string> = {
  ts: 'typescript', tsx: 'react_ts',
  js: 'javascript', jsx: 'react', mjs: 'javascript', cjs: 'javascript',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  html: 'html', htm: 'html',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  py: 'python', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php',
  c: 'c', cc: 'cpp', cpp: 'cpp', h: 'h', hpp: 'hpp', cs: 'csharp',
  sh: 'console', bash: 'console',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  svg: 'svg', vue: 'vue', svelte: 'svelte',
  sql: 'database', graphql: 'graphql',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};

export class NavBarPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ai-cli-diff-view.navBar';

  private view?: vscode.WebviewView;
  private navInfo?: NavInfo;
  private activeFilePath?: string;
  private iconBase = '';
  /**
   * Tóm tắt thay đổi của file đang xem (tổng +a/-r + danh sách khối). Đọc bất
   * đồng bộ nên có thể tạm undefined trong lúc chờ — render() vẫn chạy bình
   * thường, chỉ là chưa có danh sách.
   */
  private summary?: FileChangeSummary;
  /** Chống kết quả cũ ghi đè: mỗi lần đọc tăng số, xong so lại mới nhận. */
  private summaryRequestId = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly diffManager: DiffManager
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    const iconsDir = vscode.Uri.joinPath(this.extensionUri, 'media', 'file-icons');
    this.iconBase = webviewView.webview.asWebviewUri(iconsDir).toString() + '/';
    webviewView.webview.onDidReceiveMessage((msg: { command: string; groupId?: string }) => {
      switch (msg.command) {
        case 'prev':   vscode.commands.executeCommand('ai-cli-diff-view.prevFile'); break;
        case 'next':   vscode.commands.executeCommand('ai-cli-diff-view.nextFile'); break;
        case 'acceptAllChanges': vscode.commands.executeCommand('ai-cli-diff-view.acceptAllChanges'); break;
        // Bấm vào một dòng thay đổi (hoặc tên file) = mở diff của file đó, cuộn
        // thẳng tới khối vừa bấm.
        case 'openBlock':
          if (this.activeFilePath && msg.groupId) {
            void this.diffManager.openChangeBlock(this.activeFilePath, msg.groupId);
          }
          break;
        case 'openFile':
          if (this.activeFilePath) {
            void this.diffManager.openDiff(this.activeFilePath);
          }
          break;
        // Keep/Undo cho 1 khối của file đang xem. Webview không gửi path: panel
        // chỉ hiển thị 1 file, và đọc lại path ở đây tránh phải escape path
        // (dấu \, " và &) vào HTML attribute.
        case 'keepBlock':
          if (this.activeFilePath && msg.groupId) {
            void this.diffManager.acceptChangeBlock(this.activeFilePath, msg.groupId);
          }
          break;
        case 'undoBlock':
          if (this.activeFilePath && msg.groupId) {
            void this.diffManager.rejectChangeBlock(this.activeFilePath, msg.groupId);
          }
          break;
      }
    });
    this.render();
  }

  update(navInfo: NavInfo | undefined): void {
    this.navInfo = navInfo;
    this.render();
  }

  setActiveFile(filePath: string | undefined): void {
    // Chỉ xoá summary khi ĐỔI file: hàm này được gọi lại mỗi lần onDidChangeDiffs
    // và mỗi lần đổi tab, xoá vô điều kiện sẽ làm danh sách nhấp nháy mỗi lần
    // đọc lại (bất đồng bộ).
    if (filePath !== this.activeFilePath) {
      this.activeFilePath = filePath;
      this.summary = undefined;
    }
    this.render();
    void this.refreshSummary();
  }

  /**
   * Đọc lại tóm tắt thay đổi của file đang xem rồi render. Gọi từ
   * setActiveFile() — mà extension.ts gọi lại mỗi khi onDidChangeDiffs hoặc tab
   * đổi — nên Keep/Undo ở đây tự cập nhật danh sách.
   */
  private async refreshSummary(): Promise<void> {
    const filePath = this.activeFilePath;
    if (!filePath) { return; }
    const id = ++this.summaryRequestId;
    const summary = await this.diffManager.getFileChangeSummary(filePath);
    if (id !== this.summaryRequestId || filePath !== this.activeFilePath) { return; }
    this.summary = summary;
    this.render();
  }

  private render(): void {
    if (!this.view) { return; }
    this.view.webview.html = this.buildHtml();
  }

  private fileImg(name: string, size = 14): string {
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const iconName = EXT_ICON[ext] ?? 'file';
    const src = escapeHtml(`${this.iconBase}${iconName}.svg`);
    return `<img src="${src}" width="${size}" height="${size}" aria-hidden="true" style="flex-shrink:0;vertical-align:middle;margin-right:5px;">`;
  }

  private buildHtml(): string {
    const info = this.navInfo;
    const fileName = this.activeFilePath ? path.basename(this.activeFilePath) : undefined;
    const bgNoDiffUri = this.view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'meo_ngu.png'),
    ).toString();
    const bgHasDiffUri = this.view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'meo_diff.png'),
    ).toString();
    const bodyClass = info ? 'has-diff' : 'no-diff';

    const summary = this.summary;
    const stats = summary ? statsHtml(summary.added, summary.removed) : '';
    const changeList =
      summary && summary.groups.length > 0
        ? `<div class="change-list">${summary.groups
            .map(
              (g) =>
                `<div class="change-row" onclick="sendBlock('openBlock','${g.id}')" title="Open this change">` +
                `<span class="change-range">${escapeHtml(formatBlockRange(g))}</span>` +
                `<span class="change-actions">` +
                `<button type="button" class="change-btn undo" onclick="event.stopPropagation(); sendBlock('undoBlock','${g.id}')" title="Undo this change">Undo</button>` +
                `<button type="button" class="change-btn keep" onclick="event.stopPropagation(); sendBlock('keepBlock','${g.id}')" title="Keep this change">Keep</button>` +
                `</span>` +
                `</div>`
            )
            .join('')}</div>`
        : '';

    const controls = info ? `
      <div class="controls">
        <div class="line line-all-changes">
          <button class="btn btn-accept-all" onclick="send('acceptAllChanges')">Accept All Changes</button>
        </div>
        <div class="line line-file">
          <div class="file-label"${fileName ? ` onclick="send('openFile')" title="Open this file's diff"` : ''}>${fileName
            ? `${this.fileImg(fileName, 15)}<span>${escapeHtml(fileName)}</span>${stats}`
            : 'Open a pending diff file to accept/reject'}</div>
          <span class="counter">${info.currentIdx} / ${info.total} files</span>
        </div>
        ${changeList}
        ${
          info.total === 1
            ? `<div class="line line-nav">
          <button class="btn btn-nav" onclick="send('next')">
            ${this.fileImg(info.nextName || info.prevName || '')}${escapeHtml(info.nextName || info.prevName || 'Open pending diff')}
          </button>
        </div>`
            : `<div class="line line-nav line-prev">
          <button class="btn btn-nav btn-prev" onclick="send('prev')" ${info.canPrev ? '' : 'disabled'}>${info.canPrev ? `&#8249; ${this.fileImg(info.prevName)}${escapeHtml(info.prevName)}` : '&#8249; Start'}</button>
        </div>
        <div class="line line-nav line-next">
          <button class="btn btn-nav btn-next" onclick="send('next')" ${info.canNext ? '' : 'disabled'}>${info.canNext ? `${this.fileImg(info.nextName)}${escapeHtml(info.nextName)} &#8250;` : 'End &#8250;'}</button>
        </div>`
        }
      </div>` : `<div class="empty">No pending diffs</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    position: relative;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: transparent;
    user-select: none;
    padding: 10px 12px;
  }

  body::before {
    content: '';
    position: absolute;
    inset: 0;
    background-position: center;
    background-repeat: no-repeat;
    background-size: contain;
    pointer-events: none;
    z-index: 0;
  }

  body.no-diff::before {
    inset: 8px 0 32px;
    opacity: 1;
    background-image: url('${bgNoDiffUri}');
  }

  body.no-diff {
    justify-content: flex-end;
  }

  body.has-diff::before {
    opacity: 0.3;
    background-image: url('${bgHasDiffUri}');
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
    z-index: 1;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
  }

  .file-label {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-transform: none;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBorder, rgba(128,128,128,0.35));
    color: var(--vscode-foreground);
    border-radius: 6px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    text-align: center;
    transition: background 0.1s;
  }
  .btn:hover {
    background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
  }
  .btn:active {
    opacity: 0.7;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .btn:disabled:hover {
    background: transparent;
  }

  .line-all-changes .btn { flex: 1 1 100%; }

  .btn-accept-all {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: transparent;
  }
  .btn-accept-all:hover {
    background: var(--vscode-button-hoverBackground, rgba(76,175,80,0.2));
  }

  .btn-nav {
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
    font-size: 12px;
    padding: 7px 10px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .counter {
    flex-shrink: 0;
    font-size: 13px;
    opacity: 0.7;
    font-weight: 500;
    white-space: nowrap;
    padding: 0 4px;
  }

  .file-stats {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    flex-shrink: 0;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .stat-add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
  .stat-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }

  /* Danh sách khối thay đổi của file đang xem (kiểu Copilot). */
  .change-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    position: relative;
    z-index: 1;
  }
  .change-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }
  .change-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
  }
  .file-label { cursor: pointer; }
  .change-range {
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
  .change-actions {
    margin-left: auto;
    display: inline-flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .change-btn {
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 0 8px;
    height: 20px;
    font-family: inherit;
    font-size: 11px;
    color: inherit;
    background: transparent;
    cursor: pointer;
  }
  .change-btn.keep { background: rgba(46, 160, 67, 0.35); }
  .change-btn.keep:hover { background: rgba(46, 160, 67, 0.6); }
  .change-btn.undo { background: rgba(248, 81, 73, 0.3); }
  .change-btn.undo:hover { background: rgba(248, 81, 73, 0.55); }

  .empty {
    text-align: center;
    opacity: 0.85;
    font-style: italic;
    font-size: 12px;
    font-weight: 600;
    position: relative;
    z-index: 1;
  }
</style>
</head>
<body class="${bodyClass}">
  ${controls}
  <script>
    const vscode = acquireVsCodeApi();
    function send(cmd) { vscode.postMessage({ command: cmd }); }
    function sendBlock(cmd, groupId) { vscode.postMessage({ command: cmd, groupId: groupId }); }
  </script>
</body>
</html>`;
  }
}

/**
 * Badge +/- cho file đang xem. Chỉ hiện khi thực sự có dòng thay đổi.
 */
function statsHtml(added: number, removed: number): string {
  if (added === 0 && removed === 0) { return ''; }
  const parts: string[] = [];
  if (added > 0) { parts.push(`<span class="stat stat-add">+${added}</span>`); }
  if (removed > 0) { parts.push(`<span class="stat stat-del">-${removed}</span>`); }
  return `<span class="file-stats">${parts.join('')}</span>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
