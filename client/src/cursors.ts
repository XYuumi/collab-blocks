/**
 * RemoteCursors：远程用户光标的叠加层渲染。
 *
 * - 每个远程用户一个绝对定位的彩色光标（2px 竖线）+ 悬浮名牌；
 * - 位置 = 目标块内 offset 处 Range 矩形换算到宿主坐标系；
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
  el: HTMLElement;
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
      }
    }, 2000);
  }

  update(user: UserInfo, blockId: string, offset: number) {
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
      c = { userId: user.userId, name: user.name, color: user.color, blockId, offset, el, ts: Date.now(), labelTimer: null };
      this.cursors.set(user.userId, c);
    }
    c.name = user.name;
    c.color = user.color;
    c.blockId = blockId;
    c.offset = offset;
    c.ts = Date.now();
    c.el.classList.remove("stale");
    this.showLabel(c);
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

  removeUser(userId: string) {
    const c = this.cursors.get(userId);
    if (c) {
      if (c.labelTimer !== null) clearTimeout(c.labelTimer);
      c.el.remove();
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
    for (const c of this.cursors.values()) this.position(c);
  }

  private position(c: CursorEntry) {
    const rect = this.editor.blockRectAt(c.blockId, c.offset);
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
