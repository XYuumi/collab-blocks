/**
 * Home：文档首页 —— 我的文档列表（新建/打开/改名/删除）。
 * 纯 REST 页面（无 WebSocket）；访客显示登录引导（访客通过分享链接参与编辑）。
 */
import { getToken, openAuthModal, logout } from "./auth";

interface DocMeta {
  docId: string;
  title: string;
  updatedAt: number;
  version: number;
  mine: boolean;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (d.toDateString() === new Date().toDateString()) return `今天 ${d.toTimeString().slice(0, 5)}`;
  return d.toLocaleDateString();
}

export async function mountHome(root: HTMLElement) {
  root.innerHTML = "";
  const page = document.createElement("div");
  page.className = "home";
  root.appendChild(page);

  // 顶栏
  const header = document.createElement("header");
  header.className = "topbar home-topbar";
  page.appendChild(header);

  const main = document.createElement("div");
  main.className = "home-main";
  page.appendChild(main);

  const renderHeader = (logged: boolean, name?: string) => {
    header.innerHTML = `
      <div class="brand">协同编辑器<span class="brand-sub">Collab Editor</span></div>
      <div class="spacer"></div>`;
    if (logged) {
      const chip = document.createElement("span");
      chip.className = "user-chip";
      chip.textContent = name ?? "我";
      header.appendChild(chip);
      const out = document.createElement("button");
      out.className = "btn";
      out.textContent = "退出";
      out.addEventListener("click", () => void logout());
      header.appendChild(out);
    } else {
      const btn = document.createElement("button");
      btn.className = "btn login-btn";
      btn.textContent = "登录 / 注册";
      btn.addEventListener("click", () => openAuthModal("login"));
      header.appendChild(btn);
    }
  };

  const res = await fetch("/api/docs", { headers: { Authorization: `Bearer ${getToken()}` } }).catch(() => null);
  const logged = !!res && res.ok;

  if (!logged) {
    renderHeader(false);
    main.innerHTML = `
      <div class="home-hero">
        <h1>协同编辑器</h1>
        <p>多人实时协作的块结构文档：远程光标、块锁、断线重连补发、冲突自动合并、快照恢复。</p>
        <p class="home-dim">登录后即可创建文档并分享协作；也可以直接打开别人分享给你的链接，以访客身份参与编辑。</p>
        <button class="btn home-cta">登录 / 注册开始</button>
      </div>`;
    main.querySelector(".home-cta")!.addEventListener("click", () => openAuthModal("register"));
    return;
  }

  const payload = (await res!.json()) as { docs: DocMeta[]; user: { name: string; isGuest: boolean } };
  const data = payload.docs;
  const me = payload.user?.isGuest ? `${payload.user.name}（访客）` : payload.user?.name ?? "我";
  renderHeader(true, me);

  // 新建 + 回收站
  const bar = document.createElement("div");
  bar.className = "home-bar";
  bar.innerHTML = `<span class="home-bar-spacer"></span>`;
  const trashBtn = document.createElement("button");
  trashBtn.className = "btn home-trash";
  trashBtn.textContent = "回收站";
  trashBtn.title = "删除的文档保留 7 天";
  bar.appendChild(trashBtn);
  const newBtn = document.createElement("button");
  newBtn.className = "btn home-new";
  newBtn.textContent = "＋ 新建文档";
  bar.appendChild(newBtn);
  main.appendChild(bar);
  newBtn.addEventListener("click", async () => {
    const title = prompt("文档标题", "未命名文档");
    if (title === null) return;
    const r = await fetch("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ title }),
    });
    const created = (await r.json()) as { docId?: string; error?: string };
    if (created.docId) location.href = `/d/${created.docId}`;
    else alert(created.error ?? "创建失败");
  });
  trashBtn.addEventListener("click", () => void openTrash());

  const list = document.createElement("div");
  list.className = "home-list";
  main.appendChild(list);

  const renderItem = (d: DocMeta) => {
    const item = document.createElement("div");
    item.className = "home-item";
    const open = document.createElement("a");
    open.className = "home-item-title";
    open.href = `/d/${d.docId}`;
    open.textContent = d.title || "未命名文档";
    const meta = document.createElement("span");
    meta.className = "home-item-meta";
    meta.textContent = `${d.mine ? "我的" : "示例"} · v${d.version} · ${fmtTime(d.updatedAt)}`;
    const actions = document.createElement("span");
    actions.className = "home-item-actions";
    if (d.mine) {
      const rename = document.createElement("button");
      rename.className = "btn";
      rename.textContent = "改名";
      rename.addEventListener("click", async () => {
        const t = prompt("新标题", d.title);
        if (!t) return;
        await fetch(`/api/docs/${d.docId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ title: t }),
        });
        d.title = t;
        open.textContent = t;
      });
      const del = document.createElement("button");
      del.className = "btn home-del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        if (!confirm(`删除「${d.title}」？此操作不可恢复。`)) return;
        const r = await fetch(`/api/docs/${d.docId}`, { method: "DELETE", headers: { Authorization: `Bearer ${getToken()}` } });
        if (r.ok) item.remove();
        else alert("删除失败");
      });
      actions.appendChild(rename);
      actions.appendChild(del);
    } else {
      const badge = document.createElement("span");
      badge.className = "home-badge";
      badge.textContent = "所有人可编辑";
      actions.appendChild(badge);
    }
    item.appendChild(open);
    item.appendChild(meta);
    item.appendChild(actions);
    list.appendChild(item);
  };
  for (const d of data) renderItem(d);
  if (data.length === 0) {
    const empty = document.createElement("div");
    empty.className = "home-empty";
    empty.textContent = "还没有文档，点上面的「新建文档」开始";
    list.appendChild(empty);
  }

  // ---------------- 回收站（7 天保留） ----------------
  async function openTrash() {
    document.querySelector(".trash-modal")?.remove();
    const mask = document.createElement("div");
    mask.className = "modal-mask trash-modal";
    const box = document.createElement("div");
    box.className = "auth-modal trash-box";
    box.innerHTML = `<div class="share-head"><b>回收站</b><button class="btn trash-close">关闭</button></div><div class="trash-body"><p class="share-hint">删除的文档保留 7 天，之后自动彻底清除。</p></div>`;
    mask.appendChild(box);
    document.body.appendChild(mask);
    box.querySelector(".trash-close")!.addEventListener("click", () => mask.remove());
    mask.addEventListener("click", (e) => {
      if (e.target === mask) mask.remove();
    });
    const body = box.querySelector(".trash-body")!;
    try {
      const res = await fetch("/api/docs/trash/list", { headers: { Authorization: `Bearer ${getToken()}` } });
      const { docs: trashed } = (await res.json()) as { docs: { docId: string; title: string; deletedAt: number }[] };
      if (trashed.length === 0) {
        body.innerHTML += `<p class="home-empty">回收站是空的</p>`;
        return;
      }
      for (const t of trashed) {
        const row = document.createElement("div");
        row.className = "trash-row";
        const info = document.createElement("div");
        info.className = "trash-info";
        info.innerHTML = `<b></b><span>${new Date(t.deletedAt).toLocaleString()} 删除</span>`;
        info.querySelector("b")!.textContent = t.title || "未命名文档";
        const restore = document.createElement("button");
        restore.className = "btn";
        restore.textContent = "恢复";
        restore.addEventListener("click", async () => {
          const r = await fetch(`/api/docs/${t.docId}/restore`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` } });
          if (r.ok) {
            row.remove();
            location.reload();
          } else {
            alert(((await r.json()) as { error?: string }).error ?? "恢复失败");
          }
        });
        const purge = document.createElement("button");
        purge.className = "btn home-del";
        purge.textContent = "彻底删除";
        purge.addEventListener("click", async () => {
          if (!confirm(`彻底删除「${t.title}」？不可恢复。`)) return;
          const r = await fetch(`/api/docs/${t.docId}/purge`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` } });
          if (r.ok) row.remove();
          else alert("删除失败");
        });
        row.appendChild(info);
        row.appendChild(restore);
        row.appendChild(purge);
        body.appendChild(row);
      }
    } catch {
      body.innerHTML += `<p class="home-empty">加载失败</p>`;
    }
  }
}
