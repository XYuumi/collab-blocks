/**
 * Comments：块级评论（数据 + 右侧面板）。
 *
 * - 数据：REST 加载/新增/解决；WS `comment.added` 实时追加（按 id 去重，含发送者自己）；
 * - 面板：按块聚合线程（块文本摘要为标题），点击线程跳到块；线程内输入框回复；
 * - 未读：面板关闭期间他人新评论计入未读（docbar 气泡按钮角标 + toast）；
 * - 块上的 💬 气泡标记由 Editor 渲染（见 editor.setCommentsProvider），点击打开面板定位。
 */
import type { CommentData } from "@shared/protocol";
import { getToken } from "./auth";
import { safeStorage } from "./util";
import type { DocModel } from "./model";
import type { Editor } from "./editor";

export class Comments {
  private list: CommentData[] = [];
  private panel: HTMLElement | null = null;
  private openBlockId: string | null = null;
  private lastSeenTs = 0;
  private myUserId = "";
  private canWrite = true;
  onChange: (unresolved: number, unread: number) => void = () => {};

  constructor(
    private docId: string,
    private model: DocModel,
    private editor: Editor,
    private toast: (msg: string, kind?: "info" | "warn" | "error") => void,
  ) {}

  /** 已读标记按文档持久化：刷新页面后未读不清零 */
  private readSeenKey(): string {
    return `ce-comments-seen-${this.docId}`;
  }
  private loadSeen(): number {
    const v = Number(safeStorage.get(this.readSeenKey()));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  private saveSeen(ts: number) {
    try {
      safeStorage.set(this.readSeenKey(), String(ts));
    } catch {
      /* ignore */
    }
  }

  setMe(userId: string, canWrite: boolean, myName?: string) {
    this.myUserId = userId;
    this.canWrite = canWrite;
    if (myName) this.myName = myName;
  }

  get comments(): CommentData[] {
    return this.list;
  }

  byBlock(): Map<string, CommentData[]> {
    const m = new Map<string, CommentData[]>();
    for (const c of this.list) {
      const arr = m.get(c.blockId) ?? [];
      arr.push(c);
      m.set(c.blockId, arr);
    }
    return m;
  }

  countsFor(blockId: string): { total: number; unresolved: number } {
    const arr = this.list.filter((c) => c.blockId === blockId);
    return { total: arr.length, unresolved: arr.filter((c) => !c.resolved).length };
  }

  private stats() {
    const unresolved = this.list.filter((c) => !c.resolved).length;
    const unread = this.list.filter((c) => c.createdAt > this.lastSeenTs && c.userId !== this.myUserId).length;
    this.onChange(unresolved, this.panel ? 0 : unread);
  }

  async load() {
    try {
      const res = await fetch(`/api/docs/${this.docId}/comments`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return;
      const data = (await res.json()) as { comments: CommentData[] };
      this.list = data.comments;
      const maxTs = Math.max(0, ...this.list.map((c) => c.createdAt));
      const stored = this.loadSeen();
      this.lastSeenTs = stored > 0 ? Math.min(stored, maxTs) : maxTs; // 首次进入视为全读；此后以持久标记为准
      this.saveSeen(this.lastSeenTs);
      this.stats();
    } catch {
      /* 离线时静默 */
    }
  }

  /** WS 推送（含自己发的） */
  onRemoteAdd(comment: CommentData) {
    if (this.list.some((c) => c.id === comment.id)) return;
    this.list.push(comment);
    if (comment.userId !== this.myUserId) {
      if (this.isMentioned(comment)) {
        this.toast(`📢 ${comment.name} @提及了你`, "warn");
      } else {
        this.toast(`${comment.name} 评论了「${this.snippet(comment.blockId)}」`, "info");
      }
      this.notify(comment);
    }
    this.stats();
    if (this.panel) this.render();
  }

  /** 我是否被 @提及 */
  isMentioned(comment: CommentData): boolean {
    if (!this.myUserId || !this.myName) return false;
    return comment.body.includes("@" + this.myName);
  }
  private myName = "";

  /** 桌面通知：被 @提及时即便在前台也通知；普通评论仅后台时 */
  private notify(comment: CommentData) {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      if (safeStorage.get("ce-notify") === "0") return;
      const mentioned = this.isMentioned(comment);
      if (!document.hidden && !mentioned) return;
      const prefix = mentioned ? "@你 " : "";
      const n = new Notification("💬 " + prefix + comment.name + " 评论了你", {
        body: comment.body.slice(0, 80),
        tag: "comment-" + comment.id,
      });
      n.onclick = () => {
        window.focus();
        this.open(comment.blockId);
        n.close();
      };
    } catch { /* 静默 */ }
  }

  async add(blockId: string, body: string) {
    if (!body.trim() || !this.canWrite) {
      if (!this.canWrite) this.toast("当前为只读模式，无法评论", "warn");
      return;
    }
    try {
      const res = await fetch(`/api/docs/${this.docId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ blockId, body }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        this.toast(data.error ?? "评论失败", "error");
        return;
      }
      // 服务器会经 WS 广播给所有人（含自己），本地由 onRemoteAdd 统一追加
    } catch {
      this.toast("网络错误", "error");
    }
  }

  async toggleResolve(id: number) {
    if (!this.canWrite) return;
    try {
      await fetch(`/api/docs/${this.docId}/comments/${id}/resolve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const c = this.list.find((x) => x.id === id);
      if (c) c.resolved = !c.resolved;
      this.stats();
      this.render();
    } catch {
      /* ignore */
    }
  }

  private snippet(blockId: string): string {
    const block = this.model.block(blockId);
    if (!block) return "（原块已删除）";
    const t = block.text;
    return t.length > 12 ? `${t.slice(0, 12)}…` : t || "空块";
  }

  // ---------------------------------------------------------------- 面板

  toggle(blockId?: string) {
    if (this.panel) this.close();
    else this.open(blockId ?? null);
  }

  open(blockId: string | null) {
    this.close();
    this.openBlockId = blockId;
    this.lastSeenTs = Math.max(this.lastSeenTs, ...this.list.map((c) => c.createdAt), 0);
    this.saveSeen(this.lastSeenTs);
    const panel = document.createElement("aside");
    panel.className = "comments-panel";
    document.body.appendChild(panel);
    this.panel = panel;
    this.render();
    this.stats();
  }

  close() {
    this.panel?.remove();
    this.panel = null;
    this.openBlockId = null;
    this.stats();
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  private render() {
    const panel = this.panel;
    if (!panel) return;
    panel.innerHTML = "";
    const head = document.createElement("div");
    head.className = "comments-head";
    head.innerHTML = `<b>评论</b>`;
    const notifyBtn = document.createElement("button");
    notifyBtn.className = "btn comments-notify";
    const syncNotifyBtn = () => {
      const off = safeStorage.get("ce-notify") === "0";
      notifyBtn.textContent = off ? "🔕" : "🔔";
      notifyBtn.title = off ? "桌面通知已关，点击开启" : "桌面通知已开，点击关闭";
    };
    syncNotifyBtn();
    notifyBtn.addEventListener("click", async () => {
      if (safeStorage.get("ce-notify") === "0") {
        safeStorage.set("ce-notify", "1");
      } else if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
        const p = await Notification.requestPermission();
        if (p !== "granted") {
          this.toast("未获得通知授权，可在浏览器地址栏设置中开启", "warn");
          return;
        }
        safeStorage.set("ce-notify", "1");
      } else {
        safeStorage.set("ce-notify", safeStorage.get("ce-notify") === "0" ? "1" : "0");
      }
      syncNotifyBtn();
    });
    head.appendChild(notifyBtn);
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn comments-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "comments-body";
    panel.appendChild(body);

    const threads = this.byBlock();
    if (threads.size === 0) {
      const empty = document.createElement("div");
      empty.className = "comments-empty";
      empty.textContent = "暂无评论。悬停块左侧出现 💬 时点击，或选中块后在面板中发言。";
      body.appendChild(empty);
      return;
    }
    // 未读/打开的线程排前面
    const ordered = [...threads.entries()].sort((a, b) => {
      if (a[0] === this.openBlockId) return -1;
      if (b[0] === this.openBlockId) return 1
      return b[1][b[1].length - 1].createdAt - a[1][a[1].length - 1].createdAt;
    });
    for (const [blockId, arr] of ordered) {
      const thread = document.createElement("div");
      thread.className = "comment-thread" + (arr.every((c) => c.resolved) ? " resolved" : "") + (blockId === this.openBlockId ? " focus" : "");
      const title = document.createElement("div");
      title.className = "comment-thread-title";
      title.textContent = this.snippet(blockId);
      title.title = "点击跳转到该块";
      title.addEventListener("click", () => this.editor.scrollToBlock(blockId));
      thread.appendChild(title);

      for (const c of arr) {
        const item = document.createElement("div");
        item.className = "comment-item" + (c.resolved ? " resolved" : "");
        const meta = document.createElement("div");
        meta.className = "comment-meta";
        const dot = document.createElement("span");
        dot.className = "comment-dot";
        dot.style.background = c.color;
        const name = document.createElement("span");
        name.textContent = c.name;
        const time = document.createElement("span");
        time.className = "comment-time";
        time.textContent = new Date(c.createdAt).toLocaleString();
        meta.appendChild(dot);
        meta.appendChild(name);
        meta.appendChild(time);
        if (this.canWrite) {
          const rs = document.createElement("button");
          rs.className = "comment-resolve btn-ghost";
          rs.textContent = c.resolved ? "重新打开" : "标记解决";
          rs.addEventListener("click", () => void this.toggleResolve(c.id));
          meta.appendChild(rs);
        }
        const bodyText = document.createElement("div");
        bodyText.className = "comment-body";
        // @提及高亮（先转义再标记，防 XSS）
        const escaped = c.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const myName = this.myName;
        bodyText.innerHTML = escaped.replace(
          /@([^\s@，。！？]+)/g,
          (m) => '<span class="comment-mention' + (m.slice(1) === myName ? " me" : "") + '">' + m + "</span>",
        );
        item.appendChild(meta);
        item.appendChild(bodyText);
        thread.appendChild(item);
      }

      if (this.canWrite) {
        const input = document.createElement("div");
        input.className = "comment-input-row";
        const box = document.createElement("input");
        box.className = "comment-input";
        box.placeholder = "回复…（回车发送）";
        box.maxLength = 1000;
        const send = () => {
          const v = box.value.trim();
          if (!v) return;
          box.value = "";
          void this.add(blockId, v);
        };
        box.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          }
        });
        input.appendChild(box);
        thread.appendChild(input);
      }
      body.appendChild(thread);
    }
    const focusEl = body.querySelector(".comment-thread.focus") ?? body.lastElementChild;
    focusEl?.scrollIntoView({ block: "nearest" });
  }
}
