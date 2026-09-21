/**
 * editor-page：文档编辑页装配（协同核心 + 产品功能层）。
 *
 * v5 新增：远程选区上报（selectionchange）、全文搜索（Ctrl+F）、块级评论（面板/气泡/未读）、
 * Markdown 导出、只读"申请编辑"闭环、快捷键帮助、快照对比（见 snapshots）。
 */
import type { BlockData, DocRole, Op, ServerMsg, UserInfo } from "@shared/protocol";
import { DocModel } from "./model";
import { Net } from "./net";
import { TxQueue } from "./queue";
import { UndoManager } from "./undo";
import { Editor } from "./editor";
import { LockManager } from "./locks";
import { RemoteCursors } from "./cursors";
import { Presence } from "./presence";
import { StatusUI } from "./status";
import { SnapshotViewer } from "./snapshots";
import { AuthUI, getToken } from "./auth";
import { Outline } from "./outline";
import { openShareModal } from "./share";
import { Comments } from "./comments";
import { Search } from "./search";
import { blocksToMarkdown, blocksToPlainText, blocksToHtml, sanitizeFilename } from "./markdown";

const PENDING_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PENDING_MAX_JSON = 256 * 1024;

export interface EditorPageOpts {
  docId: string;
  mode: "edit" | "view";
}

/** 复制文本（clipboard 优先，execCommand 兜底） */
function copyText(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return true;
  } catch {
    /* fallthrough */
  }
  void navigator.clipboard?.writeText(text);
  return false;
}

function openShortcutsModal() {
  document.querySelector(".shortcuts-modal")?.remove();
  const mask = document.createElement("div");
  mask.className = "modal-mask shortcuts-modal";
  const rows: [string, string][] = [
    ["Enter", "拆分新块（列表/待办自动续型；空列表项回车转正文）"],
    ["Backspace", "块首：合并到上一块；非正文块：先转为正文"],
    ["Ctrl/⌘ + Z / Y", "撤销 / 重做（含块类型、勾选、快照恢复）"],
    ["/", "唤起块类型菜单（↑↓ 选择，Enter 确认，Esc 关闭）"],
    ["Ctrl/⌘ + F", "全文搜索（Enter / Shift+Enter 跳转）"],
    ["↑ ↓ ← →", "在块边界自动跨块移动光标"],
    ["Esc", "关闭菜单 / 搜索 / 弹层"],
    ["?", "打开本快捷键面板"],
    ["Markdown", "输入 #、-、[ ]、``` 后跟空格可快速转换块类型（[x] 空格 = 已勾选待办）"],
  ];
  const box = document.createElement("div");
  box.className = "shortcuts-box";
  box.innerHTML = `<div class="shortcuts-head"><b>键盘快捷键</b><button class="btn">关闭</button></div><div class="shortcuts-body"></div>`;
  const body = box.querySelector(".shortcuts-body")!;
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const key = document.createElement("kbd");
    key.textContent = k;
    const desc = document.createElement("span");
    desc.textContent = v;
    row.appendChild(key);
    row.appendChild(desc);
    body.appendChild(row);
  }
  box.querySelector("button")!.addEventListener("click", () => mask.remove());
  mask.addEventListener("click", (e) => {
    if (e.target === mask) mask.remove();
  });
  mask.appendChild(box);
  document.body.appendChild(mask);
}

export function mountEditor(root: HTMLElement, opts: EditorPageOpts) {
  const { docId } = opts;
  const viewerMode = opts.mode === "view";

  const model = new DocModel();
  const net = new Net(docId, opts.mode);
  const undoMgr = new UndoManager();

  root.innerHTML = "";
  const page = document.createElement("main");
  page.className = "page";
  root.appendChild(page);

  // ---------------- pending 本地持久化（关页恢复） ----------------
  const pendingKey = `ce-pending-${docId}`;
  let savePendingTimer: number | null = null;
  const savePendingSoon = () => {
    if (savePendingTimer !== null) return;
    savePendingTimer = window.setTimeout(() => {
      savePendingTimer = null;
      if (viewerMode) return;
      try {
        if (model.pending.length === 0) {
          localStorage.removeItem(pendingKey);
        } else {
          const raw = JSON.stringify({ txs: model.pending, savedAt: Date.now() });
          if (raw.length <= PENDING_MAX_JSON) localStorage.setItem(pendingKey, raw);
        }
      } catch {
        /* 配额满等，忽略 */
      }
    }, 500);
  };
  const loadStoredPending = (): { txId: string; ops: Op[] }[] | null => {
    try {
      const raw = localStorage.getItem(pendingKey);
      if (!raw || raw.length > PENDING_MAX_JSON) return null;
      const parsed = JSON.parse(raw) as { txs?: { txId: string; ops: Op[] }[]; savedAt?: number };
      if (!Array.isArray(parsed.txs) || parsed.txs.length === 0) return null;
      if (!parsed.savedAt || Date.now() - parsed.savedAt > PENDING_MAX_AGE_MS) return null;
      return parsed.txs;
    } catch {
      return null;
    }
  };

  const snapshotViewer = new SnapshotViewer(docId, {
    canRestore: !viewerMode,
    onRestore: (blocks: BlockData[]) => {
      const prevBlocks = model.blocks.map((b) => ({ ...b }));
      queue.submitImmediate([{ type: "doc.replace", blocks, prevBlocks }], { selBefore: null });
      status.toast(`已恢复到 v${snapshotViewer.lastViewedVersion}（可 Ctrl+Z 撤销）`, "info");
    },
    currentBlocks: () => model.blocks.map((b) => ({ ...b })),
    currentTitle: () => titleInput.value,
  });
  const status = new StatusUI(
    (enforced) => net.send({ t: "config", lockEnforced: enforced }),
    () => snapshotViewer.open(),
  );
  const presence = new Presence(status.presenceEl);
  const auth = new AuthUI(status.userSlot);
  auth.onToast = (msg, kind) => status.toast(msg, kind);

  // ---------------- 文档栏：返回 / 标题 / 工具组 / 只读徽标 ----------------
  const docBar = document.createElement("div");
  docBar.className = "docbar";
  const back = document.createElement("a");
  back.className = "docbar-back";
  back.href = "/";
  back.textContent = "← 文档";
  docBar.appendChild(back);
  const titleInput = document.createElement("input");
  titleInput.className = "docbar-title";
  titleInput.maxLength = 60;
  titleInput.placeholder = "未命名文档";
  titleInput.disabled = true;
  docBar.appendChild(titleInput);
  const roBadge = document.createElement("span");
  roBadge.className = "docbar-ro";
  roBadge.textContent = "👁 只读";
  roBadge.style.display = "none";
  docBar.appendChild(roBadge);

  const tools = document.createElement("div");
  tools.className = "docbar-tools";
  docBar.appendChild(tools);
  const mkBtn = (content: string, title: string, cls = "") => {
    const b = document.createElement("button");
    b.className = `btn docbar-btn ${cls}`;
    // 内容是受控的 SVG 字符串或固定文案（无用户输入），按 HTML 写入
    if (content.trimStart().startsWith("<svg")) b.innerHTML = content;
    else b.textContent = content;
    b.title = title;
    tools.appendChild(b);
    return b;
  };
  const searchBtn = mkBtn(
    `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    "全文搜索（Ctrl+F）",
    "icon-btn",
  );
  const commentsBtn = mkBtn("💬", "评论");
  const commentsBadge = document.createElement("span");
  commentsBadge.className = "docbar-badge";
  commentsBadge.style.display = "none";
  commentsBtn.appendChild(commentsBadge);
  const exportBtn = mkBtn(
    `<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7.5 11.5 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/></svg>`,
    "导出 Markdown / 纯文本 / HTML",
    "icon-btn",
  );
  const helpBtn = mkBtn(
    `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.8.3-1 .9-1 1.7"/><path d="M12 16.8v.2"/></svg>`,
    "键盘快捷键",
    "icon-btn",
  );
  const shareBtn = mkBtn("分享", "复制链接 / 权限设置", "docbar-share");
  const requestBtn = mkBtn("申请编辑", "需要编辑权限？", "docbar-request");
  requestBtn.style.display = "none";
  docBar.appendChild(requestBtn);
  root.insertBefore(docBar, page);

  // ---------------- 状态与权限 ----------------
  let isOwner = false;
  let docEnforce = false;
  let role: DocRole = viewerMode ? "viewer" : "editor";
  let me: UserInfo = { userId: "anonymous", name: "我", color: "#666", isGuest: true };

  titleInput.addEventListener("change", async () => {
    const title = titleInput.value.trim();
    if (!title || !isOwner) return;
    const res = await fetch(`/api/docs/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ title }),
    });
    status.toast(res.ok ? "标题已保存" : "标题保存失败", res.ok ? "info" : "error");
  });
  let titleSaveTimer: number | null = null;
  titleInput.addEventListener("input", () => {
    if (titleSaveTimer !== null) clearTimeout(titleSaveTimer);
    titleSaveTimer = window.setTimeout(() => titleInput.dispatchEvent(new Event("change")), 800);
  });
  shareBtn.addEventListener("click", () => {
    void openShareModal({ docId, isOwner, enforceOwnerEdit: docEnforce, onToast: (m, k) => status.toast(m, k) });
  });
  void fetch(`/api/docs/${docId}/meta`, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then((r) => (r.ok ? r.json() : null))
    .then((meta: { title?: string; isOwner?: boolean; enforceOwnerEdit?: boolean } | null) => {
      if (!meta) return;
      titleInput.value = meta.title ?? "";
      docEnforce = !!meta.enforceOwnerEdit;
      isOwner = !!meta.isOwner && !viewerMode;
      titleInput.disabled = !isOwner;
      titleInput.title = isOwner ? "修改文档标题" : "只有创建者可以改标题";
      updateRequestBtn();
    });

  // 只读用户的"申请编辑"闭环
  const updateRequestBtn = () => {
    const show = role === "viewer" && !viewerMode ? true : viewerMode;
    requestBtn.style.display = show ? "" : "none";
  };
  requestBtn.addEventListener("click", () => {
    document.querySelector(".request-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "modal-mask request-pop";
    const box = document.createElement("div");
    box.className = "share-modal";
    box.innerHTML = `<div class="share-head"><b>需要编辑权限？</b><button class="btn req-close">关闭</button></div><div class="share-body"></div>`;
    const body = box.querySelector(".share-body")!;
    if (!docEnforce) {
      body.innerHTML = `<p class="share-hint">你通过只读链接打开。本文档允许任何人编辑，直接用编辑链接进入即可：</p>`;
      const a = document.createElement("a");
      a.className = "btn req-open";
      a.href = `/d/${docId}`;
      a.textContent = "以编辑模式打开 →";
      body.appendChild(a);
    } else {
      body.innerHTML = `<p class="share-hint">创建者已开启「仅创建者可编辑」。复制下面的话发给创建者，请 TA 在分享设置中放开编辑或把编辑链接发给你：</p>`;
      const copy = document.createElement("button");
      copy.className = "btn req-copy";
      copy.textContent = "复制申请信息";
      copy.addEventListener("click", () => {
        copyText(
          `你好，我想协作编辑文档《${titleInput.value || "未命名文档"}》，这是该文档的只读链接：${location.href}\n请把编辑链接发给我，或在分享设置中允许任何人编辑。`,
        );
        status.toast("已复制申请信息", "info");
      });
      body.appendChild(copy);
    }
    box.querySelector(".req-close")!.addEventListener("click", () => pop.remove());
    pop.addEventListener("click", (e) => {
      if (e.target === pop) pop.remove();
    });
    pop.appendChild(box);
    document.body.appendChild(pop);
  });

  // 导出 Markdown
  exportBtn.addEventListener("click", () => {
    document.querySelector(".export-pop")?.remove();
    const pop = document.createElement("div");
    pop.className = "export-pop";
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "export-item";
      b.textContent = label;
      b.addEventListener("click", () => {
        fn();
        pop.remove();
      });
      pop.appendChild(b);
    };
    mk("复制 Markdown", () => {
      copyText(blocksToMarkdown(titleInput.value, model.blocks));
      status.toast("已复制 Markdown 到剪贴板", "info");
    });
    mk("下载 .md 文件", () => {
      const blob = new Blob([blocksToMarkdown(titleInput.value, model.blocks)], { type: "text/markdown;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${sanitizeFilename(titleInput.value)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    mk("复制纯文本", () => {
      copyText(blocksToPlainText(model.blocks));
      status.toast("已复制纯文本", "info");
    });
    mk("复制 HTML", () => {
      copyText(blocksToHtml(titleInput.value, model.blocks));
      status.toast("已复制 HTML", "info");
    });
    document.body.appendChild(pop);
    const r = exportBtn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.right = `${window.innerWidth - r.right}px`;
    setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (!pop.contains(e.target as Node)) {
          pop.remove();
          document.removeEventListener("mousedown", close);
        }
      };
      document.addEventListener("mousedown", close);
    }, 0);
  });
  helpBtn.addEventListener("click", openShortcutsModal);

  // ---------------- 光标/选区上报（节流 120ms） ----------------
  let cursorTimer: number | null = null;
  let pendingCursor: { blockId: string; offset: number; focusOffset?: number; focusBlockId?: string } | null = null;
  const flushCursor = () => {
    if (pendingCursor && net.open && role !== "viewer") {
      net.send({ t: "cursor", ...pendingCursor });
      pendingCursor = null;
    }
  };
  const reportCursor = (blockId: string, offset: number, focusOffset?: number, focusBlockId?: string) => {
    if (viewerMode) return;
    // 跨块选区的两个 offset 分属不同块，不能比较大小：只要 focusBlockId 不同就算选区
    const cross = !!focusBlockId && focusBlockId !== blockId;
    pendingCursor =
      focusOffset !== undefined && (focusOffset > offset || cross) ? { blockId, offset, focusOffset, focusBlockId } : { blockId, offset };
    if (cursorTimer !== null) return;
    cursorTimer = window.setTimeout(() => {
      cursorTimer = null;
      flushCursor();
    }, 120);
  };
  document.addEventListener("selectionchange", () => {
    const sel = editor.currentSelectionInfo();
    if (sel) reportCursor(sel.blockId, sel.offset, sel.focusOffset, sel.focusBlockId);
  });

  let locks: LockManager | undefined;
  let cursors: RemoteCursors | undefined;
  const queue = new TxQueue(model, net, undoMgr, {
    getAuthor: () => me.userId,
    getDocId: () => docId,
    lockDropFilter: (op: Op): string | null => locks?.dropFilterForOp(op) ?? null,
    onToast: (msg, kind) => status.toast(msg, kind),
    onResync: () => {
      if (net.open) net.send({ t: "sync", haveVersion: model.version, pendingTxIds: model.pendingIds() });
    },
  });

  const editor = new Editor(page, model, queue, undoMgr, {
    onCursor: reportCursor,
    onFocusBlock: (blockId) => {
      if (role !== "viewer") locks?.focus(blockId);
    },
    onBlurBlock: (blockId) => {
      if (role !== "viewer") locks?.blur(blockId);
    },
    onStructureChanged: () => cursors?.repositionAll(),
    onToast: (msg, kind) => status.toast(msg, kind),
    onOpenComments: (blockId) => comments.open(blockId),
  });
  locks = new LockManager(net, editor, (msg, kind) => status.toast(msg, kind));
  cursors = new RemoteCursors(editor, page);
  new Outline(model, editor, page);
  const search = new Search(model, editor, page);
  const comments = new Comments(docId, model, editor, (m, k) => status.toast(m, k));
  editor.commentsProvider = (blockId) => comments.countsFor(blockId).unresolved;
  comments.onChange = (unresolved, unread) => {
    commentsBadge.textContent = String(unresolved || "");
    commentsBadge.style.display = unresolved > 0 ? "" : "none";
    commentsBtn.title = `评论（${unresolved} 条未解决${unread > 0 ? `，${unread} 条未读` : ""}）`;
    editor.renderCommentChips();
  };
  searchBtn.addEventListener("click", () => search.open());
  commentsBtn.addEventListener("click", () => comments.toggle());
  if (viewerMode) editor.setReadOnly(true);

  // ---------------- 名字 / 主题 ----------------
  status.nameInput.value = net.preferredName;
  status.nameInput.addEventListener("change", async () => {
    const name = status.nameInput.value.trim();
    if (!name) return;
    net.savePreferredName(name);
    const err = await auth.rename(name);
    if (err) {
      status.toast(err, "error");
      status.nameInput.value = me.name;
    } else {
      status.toast(`已改名为 ${name}`, "info");
    }
  });

  status.themeBtn.addEventListener("click", () => {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("ce-theme", dark ? "dark" : "light");
    status.themeBtn.textContent = dark ? "☀️" : "🌙";
    cursors?.repositionAll();
  });
  status.themeBtn.textContent = document.documentElement.classList.contains("dark") ? "☀️" : "🌙";

  // 撤销/重做：页面级快捷键（焦点不在编辑器内也能生效；输入框内交给原生）
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "f") {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.preventDefault();
      search.open();
      return;
    }
    if (e.key === "?" && document.activeElement === document.body) {
      openShortcutsModal();
      return;
    }
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return; // 标题/名字输入框内不拦截
    e.preventDefault();
    if (key === "y" || (key === "z" && e.shiftKey)) editor.redo();
    else editor.undo();
  });

  // ---------------- 模型事件 → DOM / 统计 / pending 持久化 ----------------
  model.on((e) => {
    if (e.kind === "text") editor.reconcileBlock(e.blockId);
    else if (e.kind === "structure") editor.reconcileStructure();
    status.setVersion(model.version, queue.pendingCount());
    status.setStats(model.blocks.reduce((n, b) => n + b.text.length, 0));
    savePendingSoon();
  });

  net.onStateChange = (s) => {
    status.setConnection(s);
    if (s === "closed") queue.onDisconnected();
  };

  const requestResync = () => {
    if (net.open) net.send({ t: "sync", haveVersion: model.version, pendingTxIds: model.pendingIds() });
  };

  let adoptedStored = false;
  const storedPending = loadStoredPending();

  net.onMessage = (m: ServerMsg) => {
    switch (m.t) {
      case "init": {
        me = m.you;
        role = m.role;
        net.saveToken(m.token);
        presence.setMe(m.you);
        presence.update(m.presence);
        auth.setSession(m.you);
        status.nameInput.value = m.you.name;
        locks.setMe(m.you);
        locks.loadInit(m.locks, m.config);
        status.setLockEnforced(m.config.lockEnforced);
        const isViewer = m.role === "viewer";
        editor.setReadOnly(isViewer);
        roBadge.style.display = isViewer ? "" : "none";
        status.lockToggle.disabled = isViewer;
        comments.setMe(m.you.userId, !isViewer);
        updateRequestBtn();
        if (isViewer && !viewerMode) {
          status.toast("创建者已开启「仅创建者可编辑」，当前为只读模式", "info");
        }
        if (!model.loaded) {
          model.loadSnapshot(m.doc);
          if (!adoptedStored && storedPending) {
            adoptedStored = true;
            const dropped = model.adoptPending(storedPending);
            for (const d of dropped) status.toast(`一条离线修改未能恢复：${d.reason}`, "warn");
            if (dropped.length === 0 && storedPending.length > 0) {
              status.toast(`已恢复 ${storedPending.length} 条关页前的未同步修改，正在补发`, "info");
            }
            queue.resubmitAll();
          }
        } else {
          requestResync();
          locks.reacquire();
        }
        if (comments.comments.length === 0) void comments.load();
        break;
      }
      case "ack":
        queue.onAck(m.txId, m.version);
        break;
      case "nack":
        queue.onNack(m);
        break;
      case "remote.op":
        model.onRemoteOp(m.tx, m.version);
        break;
      case "presence": {
        const known = new Set(m.users.map((u) => u.userId));
        if (me.userId !== "anonymous") known.add(me.userId);
        presence.update(m.users);
        cursors.retain(known);
        break;
      }
      case "cursor": {
        const user = presence.getUser(m.userId);
        if (user && user.userId !== me.userId) {
          cursors.update(user, m.blockId, m.offset, m.focusOffset, m.focusBlockId);
        }
        break;
      }
      case "comment.added": {
        if (m.docId === docId) comments.onRemoteAdd(m.comment);
        break;
      }
      case "lock.changed":
        locks.onChanged(m.blockId, m.lock);
        break;
      case "lock.denied":
        if (role !== "viewer") locks.onDenied(m.blockId, m.holder);
        break;
      case "config.changed":
        locks.setConfig(m.config);
        status.setLockEnforced(m.config.lockEnforced);
        break;
      case "snapshot": {
        const sel = editor.currentSelection();
        const dropped = model.onSnapshotResync(m.doc, m.ackedTxIds);
        queue.resubmitAll();
        for (const d of dropped) status.toast(`一条修改未能恢复：${d.reason}`, "warn");
        if (m.ackedTxIds.length > 0) status.toast(`已对账：${m.ackedTxIds.length} 个事务此前已在服务器生效`, "info");
        if (sel && model.block(sel.blockId)) editor.focusBlock(sel.blockId, sel.offset);
        break;
      }
      case "error":
        status.toast(m.message, "error");
        break;
      case "pong":
        break;
    }
  };

  window.addEventListener("beforeunload", () => {
    savePendingSoon();
    net.close();
  });

  net.connect();
}
