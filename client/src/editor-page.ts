/**
 * editor-page：文档编辑页装配（原 main.ts 的协同核心 + v3 新增）。
 *
 * v3 新增：文档标题栏（创建者可改）、分享面板（编辑/只读链接）、只读模式整页降级、
 * pending 落 localStorage（关页后恢复未确认编辑）、大纲导航、快照恢复（doc.replace）。
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

const PENDING_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PENDING_MAX_JSON = 256 * 1024;

export interface EditorPageOpts {
  docId: string;
  mode: "edit" | "view";
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
      queue.submitImmediate(
        [{ type: "doc.replace", blocks, prevBlocks }],
        { selBefore: null },
      );
      status.toast(`已恢复到 v${snapshotViewer.lastViewedVersion}（可 Ctrl+Z 撤销）`, "info");
    },
  });
  const status = new StatusUI(
    (enforced) => net.send({ t: "config", lockEnforced: enforced }),
    () => snapshotViewer.open(),
  );
  const presence = new Presence(status.presenceEl);
  const auth = new AuthUI(status.userSlot);
  auth.onToast = (msg, kind) => status.toast(msg, kind);

  // ---------------- 文档栏：返回 / 标题 / 分享 / 只读徽标 ----------------
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
  roBadge.textContent = "👁 只读模式";
  roBadge.style.display = "none";
  docBar.appendChild(roBadge);
  const shareBtn = document.createElement("button");
  shareBtn.className = "btn docbar-share";
  shareBtn.textContent = "分享";
  docBar.appendChild(shareBtn);
  root.insertBefore(docBar, page);

  let isOwner = false;
  let titleSaveTimer: number | null = null;
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
  titleInput.addEventListener("input", () => {
    if (titleSaveTimer !== null) clearTimeout(titleSaveTimer);
    titleSaveTimer = window.setTimeout(() => titleInput.dispatchEvent(new Event("change")), 800);
  });
  shareBtn.addEventListener("click", () => {
    void openShareModal({
      docId,
      isOwner,
      enforceOwnerEdit: false,
      onToast: (m, k) => status.toast(m, k),
    });
  });
  // 初始 meta（标题与归属）
  void fetch(`/api/docs/${docId}/meta`, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then((r) => (r.ok ? r.json() : null))
    .then((meta: { title?: string; isOwner?: boolean; enforceOwnerEdit?: boolean } | null) => {
      if (!meta) return;
      titleInput.value = meta.title ?? "";
      isOwner = !!meta.isOwner && !viewerMode;
      titleInput.disabled = !isOwner;
      titleInput.title = isOwner ? "修改文档标题" : "只有创建者可以改标题";
    });

  // ---------------- 光标上报节流 ----------------
  let cursorTimer: number | null = null;
  let pendingCursor: { blockId: string; offset: number } | null = null;
  const reportCursor = (blockId: string, offset: number) => {
    if (viewerMode) return;
    pendingCursor = { blockId, offset };
    if (cursorTimer !== null) return;
    cursorTimer = window.setTimeout(() => {
      cursorTimer = null;
      if (pendingCursor && net.open) {
        net.send({ t: "cursor", ...pendingCursor });
        pendingCursor = null;
      }
    }, 120);
  };

  let me: UserInfo = { userId: "anonymous", name: "我", color: "#666", isGuest: true };
  let locks: LockManager | undefined;
  let cursors: RemoteCursors | undefined;
  let role: DocRole = viewerMode ? "viewer" : "editor";

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
  });
  locks = new LockManager(net, editor, (msg, kind) => status.toast(msg, kind));
  cursors = new RemoteCursors(editor, page);
  new Outline(model, editor, page);
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

  // 撤销/重做：页面级快捷键（焦点不在编辑器内——如弹窗关闭后——也能生效；输入框内交给原生）
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
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
        if (isViewer && !viewerMode) {
          status.toast("创建者已开启「仅创建者可编辑」，当前为只读模式", "info");
        }
        if (!model.loaded) {
          model.loadSnapshot(m.doc);
          // 关页前未确认的本地编辑：重放进模型，随 sync 对账补发
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
          cursors.update(user, m.blockId, m.offset);
        }
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
