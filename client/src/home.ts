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

  // 新建
  const bar = document.createElement("div");
  bar.className = "home-bar";
  bar.innerHTML = `<button class="btn home-new">＋ 新建文档</button>`;
  main.appendChild(bar);
  bar.querySelector(".home-new")!.addEventListener("click", async () => {
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
}
