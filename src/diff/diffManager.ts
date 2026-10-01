/**
 * diffManager.ts
 *
 * Snapshot + accept/revert state cho các file đang được AI sửa.
 * Render delegate hoàn toàn sang DiffEditorProvider (CustomTextEditorProvider).
 * Mỗi pending file = 1 tab webview riêng.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { calculateHunks } from './hunkCalculator';
import {
  applyGroupAccept,
  applyGroupReject,
  buildChangeGroups,
  ChangeGroup,
} from './hunkGroups';
import { detectEol, fromLf, toLf } from './eol';
import { exceedsLineLimit } from '../watcher/fileSizeLimit';
import { DIFF_EDITOR_VIEW_TYPE } from './diffWebviewPanel';
import { SnapshotStore, SnapshotState } from './snapshotStore';

function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/**
 * Trả về path với case canonical từ OS (Windows preserve case từ disk).
 * Dùng khi gọi VS Code APIs để tab/tên file hiển thị đúng case như user.
 * Fallback về input nếu file không tồn tại.
 */
function canonicalCasePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

/**
 * Tóm tắt thay đổi của một pending file: tổng số dòng thêm/xoá và danh sách
 * khối thay đổi. Sidebar dùng nó để render "danh sách thay đổi" kiểu Copilot.
 */
export interface FileChangeSummary {
  /** Tổng số dòng được thêm trong file. */
  added: number;
  /** Tổng số dòng bị xoá trong file. */
  removed: number;
  /** Các khối thay đổi, đã gom và tính sẵn (xem hunkGroups.ts). */
  groups: ChangeGroup[];
}

export class DiffManager {
  private _onDidChangeDiffs = new vscode.EventEmitter<void>();
  public readonly onDidChangeDiffs = this._onDidChangeDiffs.event;

  private snapshots: Map<string, SnapshotState> = new Map();
  private readonly store: SnapshotStore;
  /** filePath (normalized) -> active webview panel. */
  private panels: Map<string, vscode.WebviewPanel> = new Map();
  /** filePath (normalized) -> last cursor + top visible line seen in Monaco modified editor. */
  private lastCursors: Map<string, { line: number; column: number; topLine?: number }> = new Map();

  /**
   * filePath (normalized) của tab đang active NGAY TRƯỚC khi WorkspaceWatcher
   * bắt đầu tự động mở diff cho 1 cụm external write (checkout đổi vài file
   * hay hàng loạt file đều tính, xem markActiveTabBeforeAutoOpen()). undefined
   * nghĩa là không có tab file nào active lúc đó (vd: đang ở terminal/sidebar)
   * — vẫn khác với "chưa ghi hint nào", phân biệt bằng pendingActiveTabCaptured.
   */
  private pendingActiveTabPath: string | undefined;
  private pendingActiveTabCaptured = false;
  private pendingActiveTabCapturedAt = 0;
  /**
   * Hint quá cũ (vd: cụm write đó rốt cuộc không phải git checkout nên
   * clearAll() không bao giờ chạy theo sau nó) thì bỏ qua, để lần clearAll()
   * không liên quan sau đó không lỡ dùng lại path cũ. Rộng hơn nhiều so với
   * holdMs tối đa (10s) + debounce xác nhận HEAD (1s).
   */
  private static readonly PENDING_ACTIVE_TAB_TTL_MS = 15000;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new SnapshotStore(context.workspaceState);
    this.snapshots = this.store.load();
  }

  async snapshotBefore(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    if (this.snapshots.has(absPath)) {
      return;
    }
    const uri = vscode.Uri.file(absPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (isFileNotFound(err)) {
        this.snapshots.set(absPath, { content: '', fileExistedBefore: false });
        void this.store.save(this.snapshots);
        this._onDidChangeDiffs.fire();
      }
      return;
    }

    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      // Đường built-in runner cũng phải tôn trọng maxFileLines, nếu không setting
      // chỉ đúng với đường workspace watcher. Không snapshot -> openDiff() thoát
      // sớm vì không có snapshot -> file lớn không mở diff, đúng như mong đợi.
      if (exceedsLineLimit(content)) { return; }
      this.snapshots.set(absPath, { content, fileExistedBefore: true });
    } catch {
      // File có thể bị xóa hoặc không đọc được sau khi stat — không tạo snapshot rỗng.
      return;
    }
    void this.store.save(this.snapshots);
    // `snapshotBefore()` is the built-in runner's path. It used to stay silent
    // because `openDiff()` always fired the event right after; once
    // autoOpenDiffMode suppresses the tab, nothing else would refresh the
    // pending list / nav bar / context key.
    this._onDidChangeDiffs.fire();
  }

  async openDiff(filePath: string, options?: { preserveFocus?: boolean }): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (snapshot === undefined) { return; }

    let modifiedContent: string;
    try {
      modifiedContent = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))
      ).toString('utf8');
    } catch {
      return;
    }

    // So trên LF thuần: thay đổi thuần EOL (git checkout, đổi setting files.eol,
    // formatter...) cho ra 0 hunk và rơi vào nhánh dọn dẹp bên dưới, thay vì mở
    // một diff phủ cả file.
    const hunks = calculateHunks(toLf(snapshot.content), toLf(modifiedContent));
    if (hunks.length === 0) {
      this.snapshots.delete(absPath);
      this.pendingReveal.delete(absPath);
      void this.store.save(this.snapshots);
      this._onDidChangeDiffs.fire();
      return;
    }

    const preserveFocus = options?.preserveFocus === true;

    const existing = this.panels.get(absPath);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active, preserveFocus);
      this._onDidChangeDiffs.fire();
      return;
    }

    await this.closeTextTabsFor(absPath);

    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(canonicalCasePath(absPath)),
      DIFF_EDITOR_VIEW_TYPE,
      { preview: false, preserveFocus } satisfies vscode.TextDocumentShowOptions
    );
    this._onDidChangeDiffs.fire();
  }

  /**
   * Đóng mọi tab text editor đang trỏ tới file này, để diff editor mới mở
   * không tạo tab thứ hai cùng file.
   */
  private async closeTextTabsFor(absPath: string): Promise<void> {
    const targets: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) { continue; }
        if (normalizePath(tab.input.uri.fsPath) === absPath) {
          targets.push(tab);
        }
      }
    }
    if (targets.length === 0) { return; }
    try {
      await vscode.window.tabGroups.close(targets);
    } catch (err) {
      console.error('[ai-cli-diff] closeTextTabsFor failed:', err);
    }
  }

  loadSnapshot(filePath: string, content: string, fileExistedBefore = true): void {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) {
      this.snapshots.set(absPath, { content, fileExistedBefore });
      void this.store.save(this.snapshots);
      this._onDidChangeDiffs.fire();
    }
  }

  /**
   * Accept toàn bộ thay đổi của 1 file: file đã sẵn trên đĩa với currentContent,
   * chỉ cần xoá snapshot.
   *
   * `navigate: false` dành cho danh sách ở sidebar: khi thao tác phát ra từ
   * sidebar (user không đứng trong diff tab), mở lại text editor / nhảy sang
   * file pending kế tiếp sẽ cướp focus khỏi danh sách một cách bất ngờ.
   */
  async accept(filePath: string, options?: { navigate?: boolean }): Promise<void> {
    const navigate = options?.navigate !== false;
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) { return; }

    const pendingBefore = this.getPendingFiles();
    const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
    const nextTarget =
      pendingBefore.length > 1 && currentIdx !== -1
        ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
        : undefined;

    this.snapshots.delete(absPath);
    void this.store.save(this.snapshots);
    this.closePanel(absPath);
    if (navigate) {
      await this.reopenAsTextEditor(absPath);
      if (nextTarget) {
        await this.openDiff(nextTarget);
      }
    }
    this._onDidChangeDiffs.fire();
  }

  /**
   * Revert toàn bộ: ghi originalContent ra đĩa.
   * Nếu file vốn không tồn tại trước đó -> xoá file.
   */
  async revert(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    const pendingBefore = this.getPendingFiles();
    const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
    const nextTarget =
      pendingBefore.length > 1 && currentIdx !== -1
        ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
        : undefined;

    if (snapshot.fileExistedBefore) {
      await this.writeFile(absPath, snapshot.content);
    } else {
      await this.deleteFile(absPath);
    }

    this.snapshots.delete(absPath);
    void this.store.save(this.snapshots);
    this.closePanel(absPath);
    if (snapshot.fileExistedBefore) {
      await this.reopenAsTextEditor(absPath);
    } else {
      this.lastCursors.delete(absPath);
    }

    if (nextTarget) {
      await this.openDiff(nextTarget);
    }
    this._onDidChangeDiffs.fire();
  }

  async acceptAllPending(): Promise<number> {
    const pendingFiles = this.getPendingFiles();
    const count = pendingFiles.length;
    this.snapshots.clear();
    void this.store.save(this.snapshots);
    for (const p of pendingFiles) {
      this.closePanel(normalizePath(p));
      this.pendingReveal.delete(normalizePath(p));
    }
    this._onDidChangeDiffs.fire();
    return count;
  }

  hasPendingDiff(filePath: string): boolean {
    return this.snapshots.has(normalizePath(filePath));
  }

  getPendingFiles(): string[] {
    return Array.from(this.snapshots.keys());
  }

  getSnapshot(filePath: string): string | undefined {
    return this.snapshots.get(normalizePath(filePath))?.content;
  }

  /** Alias dùng bởi DiffEditorProvider; trả về content của snapshot (left side). */
  getSnapshotContent(filePath: string): string | undefined {
    return this.getSnapshot(filePath);
  }

  /**
   * filePath (normalized) -> id khối cần cuộn tới ngay sau khi diff tab mở /
   * render xong. Đặt trước openDiff() vì tab mới chỉ render xong khi webview gửi
   * 'ready' — lúc đó message mới có chỗ để gửi.
   */
  private pendingReveal = new Map<string, string>();

  /**
   * Mở diff của file rồi cuộn tới đúng khối thay đổi (dùng cho danh sách thay
   * đổi ở sidebar / nav bar).
   */
  async openChangeBlock(filePath: string, groupId: string): Promise<void> {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) { return; }
    this.pendingReveal.set(absPath, groupId);
    await this.openDiff(absPath);
  }

  /** Dùng 1 lần: DiffEditorProvider gọi khi dựng message `set`. */
  consumePendingReveal(filePath: string): string | undefined {
    const absPath = normalizePath(filePath);
    const groupId = this.pendingReveal.get(absPath);
    this.pendingReveal.delete(absPath);
    return groupId;
  }

  /**
   * Tóm tắt thay đổi hiện tại của 1 pending file (tổng dòng +a/-r và danh sách
   * khối). Trả `undefined` nếu file không còn pending hoặc không đọc được.
   *
   * Nội dung so sánh hoàn toàn ở LF, giống DiffEditorProvider.postSet() — hai
   * bên phải cho ra cùng tập khối, nếu không thì chỉ số khối ở sidebar sẽ trỏ
   * nhầm sang thay đổi khác.
   */
  async getFileChangeSummary(filePath: string): Promise<FileChangeSummary | undefined> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return undefined; }
    const current = await this.readCurrentText(absPath);
    if (current === undefined) { return undefined; }

    const groups = buildChangeGroups(calculateHunks(toLf(snapshot.content), toLf(current)));
    let added = 0;
    let removed = 0;
    for (const g of groups) {
      added += g.addedCount;
      removed += g.removedCount;
    }
    return { added, removed, groups };
  }

  /** Nội dung hiện tại (LF) của file: ưu tiên document đang mở, không thì đọc đĩa. */
  private async readCurrentText(absPath: string): Promise<string | undefined> {
    const doc = vscode.workspace.textDocuments.find(d => normalizePath(d.uri.fsPath) === absPath);
    if (doc) { return toLf(doc.getText()); }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
      return toLf(Buffer.from(bytes).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  setLastCursor(filePath: string, line: number, column: number, topLine?: number): void {
    this.lastCursors.set(normalizePath(filePath), { line, column, topLine });
  }

  getActiveFilePath(): string | undefined {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (active?.input instanceof vscode.TabInputCustom) {
      if (active.input.viewType === DIFF_EDITOR_VIEW_TYPE) {
        return normalizePath(active.input.uri.fsPath);
      }
    }
    // Fallback: first panel in map.
    const first = this.panels.keys().next();
    return first.done ? undefined : first.value;
  }

  disposeAll(): void {
    this.snapshots.clear();
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  /**
   * Xoá toàn bộ pending (vd: git branch switch). Cần persist clean state để
   * sau reload window không bị `SnapshotStore.load()` kéo lại.
   *
   * Nếu tab đang active đúng là 1 diff tab bị xoá, mở lại nó dưới dạng text
   * editor thường (giữ cursor/scroll) thay vì để nó biến mất đột ngột — chỉ
   * áp dụng cho tab đang active, KHÔNG áp dụng cho mọi panel bị đóng (nếu
   * không sẽ mở lại hàng loạt tab cho các file nền user không đang xem).
   */
  async clearAll(): Promise<void> {
    const hint = this.consumePendingActiveTabHint();
    const activeDiffPath = hint.captured
      ? (hint.path !== undefined && this.snapshots.has(hint.path) ? hint.path : undefined)
      : this.getLiveActiveDiffPath();

    this.disposeAll();
    await this.store.clear();

    if (activeDiffPath) {
      await this.reopenAsTextEditor(activeDiffPath);
    }
  }

  private getLiveActiveDiffPath(): string | undefined {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return activeTab?.input instanceof vscode.TabInputCustom &&
      activeTab.input.viewType === DIFF_EDITOR_VIEW_TYPE &&
      this.panels.has(normalizePath(activeTab.input.uri.fsPath))
        ? normalizePath(activeTab.input.uri.fsPath)
        : undefined;
  }

  /**
   * Gọi bởi WorkspaceWatcher ở write ĐẦU TIÊN của 1 cụm external write sắp tự
   * động mở diff (xem WorkspaceWatcher.resolveOrHold — áp dụng cho cả mở ngay
   * lẫn hold-rồi-dump, không riêng burst). Ghi lại tab đang active THẬT SỰ tại
   * thời điểm đó — trước khi các openDiff() không đồng bộ trong cụm chạy đua
   * khiến activeTab trở nên ngẫu nhiên. clearAll() (khi git xác nhận branch
   * đổi đến sau đó) sẽ ưu tiên dùng giá trị này thay vì tab thắng cuộc đua.
   */
  markActiveTabBeforeAutoOpen(): void {
    this.pendingActiveTabPath = this.getCurrentTabFsPath();
    this.pendingActiveTabCaptured = true;
    this.pendingActiveTabCapturedAt = Date.now();
  }

  private getCurrentTabFsPath(): string | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const uri =
      tab?.input instanceof vscode.TabInputText ? tab.input.uri :
      tab?.input instanceof vscode.TabInputCustom ? tab.input.uri :
      tab?.input instanceof vscode.TabInputNotebook ? tab.input.uri :
      undefined;
    return uri ? normalizePath(uri.fsPath) : undefined;
  }

  /** Dùng 1 lần: đọc xong luôn reset state, để lần clearAll() sau (không có
   *  cụm auto-open nào xảy ra trước đó) không vô tình dùng lại hint cũ. */
  private consumePendingActiveTabHint(): { captured: boolean; path: string | undefined } {
    const captured = this.pendingActiveTabCaptured;
    const path = this.pendingActiveTabPath;
    const capturedAt = this.pendingActiveTabCapturedAt;
    this.pendingActiveTabCaptured = false;
    this.pendingActiveTabPath = undefined;
    this.pendingActiveTabCapturedAt = 0;
    if (!captured || Date.now() - capturedAt > DiffManager.PENDING_ACTIVE_TAB_TTL_MS) {
      return { captured: false, path: undefined };
    }
    return { captured, path };
  }

  // ---- Panel registry (gọi bởi DiffEditorProvider) ----

  registerPanel(filePath: string, panel: vscode.WebviewPanel): void {
    const absPath = normalizePath(filePath);

    // openDiff() là async (await vscode.openWith) — nếu clearAll()/disposeAll()
    // chạy xong TRƯỚC khi tab này kịp mở (vd: git branch confirm ngay giữa lúc
    // đang mở), snapshot đã bị xoá nhưng panel này chưa kịp đăng ký nên không
    // bị đóng theo. Không có gì để diff nữa — đóng luôn ở đây (đồng bộ, sớm
    // hơn nhiều so với việc chờ webview Monaco load xong rồi tự đóng qua
    // postSet()).
    if (!this.snapshots.has(absPath)) {
      panel.dispose();
      return;
    }

    const existing = this.panels.get(absPath);
    if (existing && existing !== panel) {
      existing.dispose();
    }
    this.panels.set(absPath, panel);
  }

  unregisterPanel(filePath: string, panel: vscode.WebviewPanel): void {
    const absPath = normalizePath(filePath);
    const existing = this.panels.get(absPath);
    if (existing === panel) {
      this.panels.delete(absPath);
      this._onDidChangeDiffs.fire();
    }
  }

  private closePanel(absPath: string): void {
    const panel = this.panels.get(absPath);
    if (panel) {
      this.panels.delete(absPath);
      panel.dispose();
    }
  }

  private async reopenAsTextEditor(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    } catch (err) {
      if (!isFileNotFound(err)) {
        console.error('[ai-cli-diff] cannot stat file before reopening:', err);
      }
      this.lastCursors.delete(absPath);
      return;
    }
    const cursor = this.lastCursors.get(absPath);
    this.lastCursors.delete(absPath);
    const uri = vscode.Uri.file(canonicalCasePath(absPath));
    const showOptions: vscode.TextDocumentShowOptions = { preview: false };
    if (cursor) {
      const pos = new vscode.Position(
        Math.max(0, cursor.line - 1),
        Math.max(0, cursor.column - 1)
      );
      showOptions.selection = new vscode.Range(pos, pos);
    }
    try {
      const editor = await vscode.window.showTextDocument(uri, showOptions);
      if (cursor?.topLine !== undefined) {
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const top = Math.min(lastLine, Math.max(0, cursor.topLine - 1));
        editor.revealRange(
          new vscode.Range(top, 0, top, 0),
          vscode.TextEditorRevealType.AtTop
        );
      }
    } catch (err) {
      console.error('[ai-cli-diff] reopenAsTextEditor failed:', err);
    }
  }

  // ---- Hunk-level operations (gọi bởi webview qua provider) ----

  /**
   * Accept 1 hunk: webview đã tính newOriginal (snapshot trồi lên include hunk),
   * newCurrent giữ nguyên. Chỉ update snapshot + có thể đóng nếu hết hunk.
   */
  async applyHunkAcceptFromWebview(
    filePath: string,
    newOriginal: string,
    newCurrent: string,
    options?: { navigate?: boolean }
  ): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    // newOriginal từ webview ở LF -> trả về đúng EOL của snapshot cũ, để snapshot
    // luôn giữ nguyên dạng byte gốc của file và revert() khôi phục chuẩn xác.
    this.snapshots.set(absPath, {
      ...snapshot,
      content: fromLf(newOriginal, detectEol(snapshot.content)),
    });
    void this.store.save(this.snapshots);

    if (newOriginal === newCurrent) {
      await this.accept(absPath, options);
    } else {
      this._onDidChangeDiffs.fire();
    }
  }

  /**
   * Reject 1 hunk: webview đã tính newCurrent (rollback hunk về original),
   * newOriginal giữ nguyên. Ghi newCurrent ra đĩa.
   */
  async applyHunkRejectFromWebview(
    filePath: string,
    newOriginal: string,
    newCurrent: string,
    options?: { navigate?: boolean }
  ): Promise<void> {
    const navigate = options?.navigate !== false;
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    // newCurrent từ webview ở LF -> writeFile khôi phục EOL thật của file.
    await this.writeFile(absPath, newCurrent, { fromLf: true });

    if (newOriginal === newCurrent) {
      if (!snapshot.fileExistedBefore && newCurrent.length === 0) {
        await this.deleteFile(absPath);
      }
      const pendingBefore = this.getPendingFiles();
      const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
      const nextTarget =
        pendingBefore.length > 1 && currentIdx !== -1
          ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
          : undefined;

      this.snapshots.delete(absPath);
      void this.store.save(this.snapshots);
      this.closePanel(absPath);

      if (navigate && nextTarget) {
        await this.openDiff(nextTarget);
      }
    }
    this._onDidChangeDiffs.fire();
  }

  /**
   * Accept 1 khối thay đổi theo `groupId` (từ danh sách ở sidebar). Khối được
   * tính lại tại đây từ snapshot + nội dung hiện tại, nên nó phải cho ra đúng
   * tập khối mà sidebar đang hiển thị — cả hai đều dùng buildChangeGroups().
   */
  async acceptChangeBlock(filePath: string, groupId: string): Promise<void> {
    const found = await this.findChangeBlock(filePath, groupId);
    if (!found) { return; }
    const { newOriginal, newCurrent } = applyGroupAccept(
      found.originalContent, found.currentContent, found.group
    );
    // Thao tác phát ra từ sidebar -> đừng cướp focus bằng cách mở text editor
    // hay nhảy sang file pending kế tiếp.
    await this.applyHunkAcceptFromWebview(filePath, newOriginal, newCurrent, { navigate: false });
  }

  /**
   * Reject 1 khối thay đổi theo `groupId`: ghi phần nguyên bản của riêng khối
   * đó trở lại file trên đĩa.
   */
  async rejectChangeBlock(filePath: string, groupId: string): Promise<void> {
    const found = await this.findChangeBlock(filePath, groupId);
    if (!found) { return; }
    const { newOriginal, newCurrent } = applyGroupReject(
      found.originalContent, found.currentContent, found.group
    );
    await this.applyHunkRejectFromWebview(filePath, newOriginal, newCurrent, { navigate: false });
  }

  private async findChangeBlock(
    filePath: string,
    groupId: string
  ): Promise<{ group: ChangeGroup; originalContent: string; currentContent: string } | undefined> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return undefined; }
    const current = await this.readCurrentText(absPath);
    if (current === undefined) { return undefined; }

    const originalContent = toLf(snapshot.content);
    const group = buildChangeGroups(calculateHunks(originalContent, current))
      .find(g => g.id === groupId);
    return group ? { group, originalContent, currentContent: current } : undefined;
  }

  /**
   * @param opts.fromLf `content` đang ở LF thuần (đến từ webview) và cần khôi phục
   *   EOL thật của file trước khi ghi. Bỏ trống khi content đã đúng dạng byte gốc
   *   (vd: revert() ghi thẳng snapshot).
   */
  private async writeFile(
    absPath: string,
    content: string,
    opts?: { fromLf?: boolean }
  ): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const doc = vscode.workspace.textDocuments.find(d => normalizePath(d.uri.fsPath) === absPath);

    let payload = content;
    if (opts?.fromLf) {
      // Document đang mở là nguồn đáng tin nhất — đó chính là EOL VS Code sẽ ghi.
      // Không mở thì suy từ nội dung hiện có trên đĩa.
      let eol: '\r\n' | '\n';
      if (doc) {
        eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      } else {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          eol = detectEol(Buffer.from(bytes).toString('utf8'));
        } catch {
          eol = '\n';
        }
      }
      payload = fromLf(content, eol);
    }

    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.lineAt(doc.lineCount - 1).range.end
      );
      edit.replace(uri, fullRange, payload);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(payload, 'utf8'));
    }
  }

  private async deleteFile(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath));
    } catch (err) {
      if (!isFileNotFound(err)) {
        throw err;
      }
    }
  }
}
