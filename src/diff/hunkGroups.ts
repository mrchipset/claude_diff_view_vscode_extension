/**
 * hunkGroups.ts
 *
 * Gom `Hunk[]` trở lại thành các KHỐI THAY ĐỔI liền kề — đơn vị thao tác
 * Accept/Reject, và cũng là đơn vị hiển thị trong danh sách thay đổi ở sidebar.
 *
 * Phía `hunkCalculator.ts` (Pass 3, `splitAlignedLines`) tách mỗi khối liền kề
 * thành từng cặp dòng để dòng cũ render đúng ngay trên dòng mới. Việc gom lại
 * được thực hiện ở đây theo hai điều kiện cắt:
 *
 *   1. `groupId` đổi -> đã có DÒNG KHÔNG ĐỔI xen giữa.
 *   2. hunk con này có DÒNG XOÁ trong khi khối đang gom đã có DÒNG THÊM
 *      -> mọi chuyển tiếp thêm -> xoá đều mở khối mới.
 *
 * Hệ quả của (2): mỗi dòng bị thay thế có nút riêng, còn dòng thêm mới không có
 * dòng xoá đối ứng thì dính vào cặp ngay phía trên nó. Vài hình dạng đáng nhớ:
 * `X T X T` -> 2 khối; `X T T` -> 1 khối; `X X T` -> 1 khối (lúc gặp dòng xoá
 * thứ hai khối chưa có dòng thêm nào); xoá thuần / thêm thuần -> 1 khối.
 *
 * Điều kiện (2) là PHÂN KỲ CÓ CHỦ ĐÍCH khỏi quy ước git: `git add -p` từ chối
 * tách khi giữa hai thay đổi không có dòng context. Ở đây cố ý mịn hơn.
 *
 * Trước đây logic này chỉ nằm trong webview (`buildGroups()` trong
 * res/webview/diff.monaco.js). Sidebar (danh sách thay đổi) và DiffManager cần
 * đúng cùng một cách chia khối để mỗi dòng Keep/Undo trỏ đúng khối, nên nó được
 * chuyển thành nguồn duy nhất ở đây: extension tính `groups` rồi gửi kèm message
 * `set`; webview chỉ đọc lại, không tự chia nữa.
 *
 * Gom theo run liên tiếp chứ không gom bằng Map: thứ tự trên-xuống vốn đã được
 * đảm bảo, và làm thế biến nó thành ràng buộc cấu trúc thay vì tình cờ. Vì mỗi
 * khối vẫn là một dải con LIÊN TIẾP của cùng một `groupId` (hoặc một hunk đơn
 * khi `groupId` bị tách), nó liền kề trong cả hai không gian chỉ số — bất biến
 * mà Accept/Reject dựa vào để gộp cả khối bằng một slice().concat().
 */

import { Hunk } from './hunkCalculator';

/**
 * Một khối thay đổi liền kề — đơn vị Accept/Reject và đơn vị của danh sách
 * thay đổi. Mọi field đã được tính sẵn để đường nóng (hover, cuộn, render danh
 * sách) chỉ còn là đọc.
 */
export interface ChangeGroup {
  /** Id ổn định trong một lần tính (`g0`, `g1`, ...), dùng để trỏ khối từ sidebar. */
  id: string;
  /**
   * Không còn 1-1 với `Hunk.groupId`: một groupId có thể sinh nhiều khối do
   * điều kiện cắt (2). Giữ lại để so ranh giới dòng không đổi.
   */
  groupId: string;
  /** Vị trí bắt đầu trong nội dung ORIGINAL (0-indexed). */
  originalStart: number;
  /** Vị trí bắt đầu trong nội dung MODIFIED (0-indexed). */
  modifiedStart: number;
  /** Số dòng bị xoá của cả khối. */
  removedCount: number;
  /** Số dòng được thêm của cả khối. */
  addedCount: number;
  /** Nội dung các dòng bị xoá, theo thứ tự trên-xuống. */
  removedTexts: string[];
  /** Nội dung các dòng được thêm, theo thứ tự trên-xuống. */
  addedTexts: string[];
  /** Dòng neo (1-indexed) trong nội dung modified — dùng cho F7 và auto-reveal. */
  anchorLine: number;
  /** Dòng đầu/cuối (1-indexed) mà khối chiếm trên nội dung modified. */
  startLine: number;
  endLine: number;
}

export function buildChangeGroups(hunks: Hunk[]): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  let cur: ChangeGroup | null = null;

  for (const hunk of hunks) {
    const current = cur;
    const sameBlock = current !== null
      && current.groupId === hunk.groupId
      && !(hunk.removedLines.length > 0 && current.addedTexts.length > 0);

    if (!sameBlock || current === null) {
      cur = {
        id: 'g' + groups.length,
        groupId: hunk.groupId,
        // Của hunk con ĐẦU TIÊN, không phải min/max: hunk con chỉ-thêm và cặp
        // ngay sau nó có thể trùng originalStart, nên max() không phải điểm cuối.
        originalStart: hunk.originalStart,
        modifiedStart: hunk.modifiedStart,
        removedCount: 0,
        addedCount: 0,
        removedTexts: hunk.removedLines.map(r => r.text),
        addedTexts: hunk.addedLines.map(a => a.text),
        anchorLine: 1,
        startLine: 1,
        endLine: 1,
      };
      groups.push(cur);
    } else {
      for (const r of hunk.removedLines) { current.removedTexts.push(r.text); }
      for (const a of hunk.addedLines) { current.addedTexts.push(a.text); }
    }
  }

  for (const group of groups) {
    group.removedCount = group.removedTexts.length;
    group.addedCount = group.addedTexts.length;
    group.anchorLine = Math.max(1, group.modifiedStart + 1);
    if (group.addedCount > 0) {
      // Các dòng thêm của một group luôn liền nhau kể từ modifiedStart, kể cả
      // khi giữa group có hunk con chỉ-xoá (nó không sinh dòng phía modified).
      group.startLine = group.modifiedStart + 1;
      group.endLine = group.modifiedStart + group.addedCount;
    } else {
      group.startLine = group.modifiedStart;
      group.endLine = Math.max(1, group.modifiedStart + 1);
    }
  }

  return groups;
}

/** Kết quả của một thao tác Accept/Reject lên một khối. */
export interface GroupEditResult {
  newOriginal: string;
  newCurrent: string;
}

/**
 * Nhãn dòng của một khối cho danh sách thay đổi: `L12`, `L12-14` khi khối thêm
 * nhiều dòng liền nhau, còn khối xoá thuần thì neo vào dòng modified nơi nội
 * dung bị mất.
 */
export function formatBlockRange(group: ChangeGroup): string {
  if (group.addedCount > 0) {
    const start = group.modifiedStart + 1;
    const end = group.modifiedStart + group.addedCount;
    return start === end ? `L${start}` : `L${start}-${end}`;
  }
  return `L${Math.max(1, group.modifiedStart + 1)}`;
}

/**
 * Accept cả khối: gộp phần modified VÀO baseline bên trái.
 * `newOriginal`: thay `removedCount` dòng kể từ `originalStart` bằng `addedTexts`.
 * `newCurrent`: không đổi.
 *
 * Một splice cho cả khối tương đương từng byte với splice của hunk cha trước khi
 * Pass 3 tách. Không được lặp từng hunk con: splice đầu tiên sẽ dịch mọi chỉ số
 * phía sau.
 *
 * Dùng slice().concat() chứ không phải splice(...spread): một khối có thể lớn
 * bằng cả file, và spread hàng chục nghìn phần tử làm nổ giới hạn số đối số.
 */
export function applyGroupAccept(
  originalContent: string,
  currentContent: string,
  group: ChangeGroup
): GroupEditResult {
  const origLines = originalContent.split('\n');
  const newOriginal = origLines
    .slice(0, group.originalStart)
    .concat(group.addedTexts, origLines.slice(group.originalStart + group.removedCount))
    .join('\n');
  return { newOriginal, newCurrent: currentContent };
}

/**
 * Reject cả khối: trả phần modified về đúng nguyên bản.
 * `newCurrent`: thay `addedCount` dòng kể từ `modifiedStart` bằng `removedTexts`.
 * `newOriginal`: không đổi.
 */
export function applyGroupReject(
  originalContent: string,
  currentContent: string,
  group: ChangeGroup
): GroupEditResult {
  const modLines = currentContent.split('\n');
  const newCurrent = modLines
    .slice(0, group.modifiedStart)
    .concat(group.removedTexts, modLines.slice(group.modifiedStart + group.addedCount))
    .join('\n');
  return { newOriginal: originalContent, newCurrent };
}
