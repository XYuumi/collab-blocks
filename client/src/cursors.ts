/**
 * RemoteCursors：远程用户光标 + 选区高亮的叠加层渲染。
 *
 * - 每个远程用户一个绝对定位的彩色光标（2px 竖线）+ 悬浮名牌（移动后 2s 淡出）；
 * - 对方选中文字时（cursor 消息携带 focusOffset）按行渲染半透明选区色块；
 * - 位置 = 块内 offset 处 Range 矩形换算到宿主坐标系；
 * - 文本/结构变化、滚动、窗口尺寸变化时统一重定位；超时未更新自动隐藏。
 */
import type { UserInfo } from "@shared/protocol";
import type { Editor } from "./editor";

interface CursorEntry {
  userId: string;
  name: string;
  color: string;
  blockId: string;
  offset: number;
  focusOffset?: number;
  el: HTMLElement;
  selEls: HTMLElement[];
  ts: number;
  labelTimer: number | null;
}

const STALE_MS = 8000;
const LABEL_VISIBLE_MS = 2000;

export class RemoteCursors {
  private cursors = new Map<string, CursorEntry>();

  constructor(
    private editor: Editor,
    private host: HTMLElement,
  ) {
    const onMove = () => this.repositionAll();
    window.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    window.setInterval(() => {
      const now = Date.now();
      for (const c of this.cursors.values()) {
        c.el.classList.toggle("stale", now - c.ts > STALE_MS);
        for (const s of c.selEls) s.classList.toggle("stale", now - c.ts > STALE_MS);
      }
    }, 2000);
  }

  update(user: UserInfo, blockId: string, offset: number, focusOffset?: number) {
    let c = this.cursors.get(user.userId);
    if (!c) {
      const el = document.createElement("div");
      el.className = "remote-caret";
      const bar = document.createElement("div");
      bar.className = "remote-caret-bar";
      bar.style.background = user.color;
      const label = document.createElement("span");
      label.className = "remote-caret-label";
      label.textContent = user.name;
      label.style.background = user.color;
      el.appendChild(bar);
      el.appendChild(label);
      this.host.appendChild(el);
      c = { userId: user.userId, name: user.name, color: user.color, blockId, offset, el, selEls: [], ts: Date.now(), labelTimer: null };
      this.cursors.set(user.userId, c);
    }
    c.name = user.name;
    c.color = user.color;
    c.blockId = blockId;
    c.offset = offset;
    c.focusOffset = focusOffset;
    c.ts = Date.now();
    c.el.classList.remove("stale");
    this.showLabel(c);
    this.renderSelection(c);
    this.position(c);
  }

  /** 名牌只在光标移动后短暂显示，避免长期遮挡上一行文字 */
  private showLabel(c: CursorEntry) {
    c.el.classList.remove("label-hidden");
    if (c.labelTimer !== null) clearTimeout(c.labelTimer);
    c.labelTimer = window.setTimeout(() => {
      c.labelTimer = null;
      c.el.classList.add("label-hidden");
    }, LABEL_VISIBLE_MS);
  }

  /** 渲染/清除选区高亮（对方选中文字时） */
  private renderSelection(c: CursorEntry) {
    for (const s of c.selEls) s.remove();
    c.selEls = [];
    const hasSel = c.focusOffset !== undefined && c.focusOffset > c.offset;
    if (!hasSel) return;
    const rects = this.editor.rectsForRange(c.blockId, c.offset, c.focusOffset!);
    const host = this.host.getBoundingClientRect();
    for (const r of rects) {
      const div = document.createElement("div");
      div.className = "remote-selection";
      div.style.background = c.color;
      div.style.left = `${r.left - host.left}px`;
      div.style.top = `${r.top - host.top}px`;
      div.style.width = `${r.width}px`;
      div.style.height = `${r.height}px`;
      this.host.appendChild(div);
      c.selEls.push(div);
    }
  }

  removeUser(userId: string) {
    const c = this.cursors.get(userId);
    if (c) {
      if (c.labelTimer !== null) clearTimeout(c.labelTimer);
      c.el.remove();
      for (const s of c.selEls) s.remove();
      this.cursors.delete(userId);
    }
  }

  /** 只保留这些人（presence 变化时清理离线用户的光标） */
  retain(userIds: Set<string>) {
    for (const id of [...this.cursors.keys()]) {
      if (!userIds.has(id)) this.removeUser(id);
    }
  }

  repositionAll() {
    for (const c of this.cursors.values()) {
      this.renderSelection(c);
      this.position(c);
    }
  }

  private position(c: CursorEntry) {
    // 有选区时光标画在选区终点
    const caretOffset = c.focusOffset !== undefined && c.focusOffset > c.offset ? c.focusOffset : c.offset;
    const rect = this.editor.blockRectAt(c.blockId, caretOffset);
    if (!rect) {
      c.el.style.display = "none";
      return;
    }
    const host = this.host.getBoundingClientRect();
    c.el.style.display = "";
    c.el.style.left = `${rect.left - host.left}px`;
    c.el.style.top = `${rect.top - host.top}px`;
    c.el.style.height = `${Math.max(rect.height, 16)}px`;
    const label = c.el.querySelector<HTMLElement>(".remote-caret-label");
    if (label) label.style.background = c.color;
    const bar = c.el.querySelector<HTMLElement>(".remote-caret-bar");
    if (bar) bar.style.background = c.color;
  }
}
