/**
 * Home：文档首页 —— 我的文档列表（新建/打开/改名/删除）。
 * 纯 REST 页面（无 WebSocket）；访客显示登录引导（访客通过分享链接参与编辑）。
 */
import { getToken, openAuthModal, logout } from "./auth";
import { markdownToBlocks } from "./markdown";
import { safeStorage } from "./util";
import { uuid } from "@shared/protocol";

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

/** 特性卡内容（登录/未登录共用） */
function mountIntroCards(container: HTMLElement, guest: boolean) {
  const grid = document.createElement("div");
  grid.className = "home-intro-grid";
  const cards: [string, string, string][] = [
    ["⚡", "实时同步", "多人同时编辑，输入即达；远程光标与选区高亮让你看见对方正在改哪里"],
    ["🧱", "块结构", "标题/列表/待办/代码/图片块；键入 / 唤起菜单，或 # 空格、[ ] 空格等 Markdown 快捷转换"],
    ["🔗", "分享与权限", "编辑链接 + 只读链接双轨分发；开放编辑/受限编辑两档权限，可维护协作者名单"],
    ["🛡", "断线不丢", "断网照常编辑，重连自动补发；关页前的未同步修改也能恢复；每次提交即落盘"],
    ["⏪", "版本与快照", "每个事务推进版本号；一键恢复历史快照（可撤销），支持与当前内容对比"],
    ["💬", "评论与搜索", "块级评论线程（实时推送+未读角标+桌面通知）；Ctrl+F 全文搜索高亮跳转"],
  ];
  for (const [icon, title, desc] of cards) {
    const card = document.createElement("div");
    card.className = "home-intro-card";
    card.innerHTML = `<div class="home-intro-icon">${icon}</div><div><h3></h3><p></p></div>`;
    card.querySelector("h3")!.textContent = title;
    card.querySelector("p")!.textContent = desc;
    grid.appendChild(card);
  }
  container.appendChild(grid);
  if (!guest) {
    const more = document.createElement("p");
    more.className = "home-intro-more";
    more.innerHTML = `快速上手：新建文档 → 点「分享」复制链接发给同伴 → 两个页面同时编辑试试。
      完整设计文档见仓库 <code>docs/</code> 目录。`;
    container.appendChild(more);
  } else {
    const more = document.createElement("p");
    more.className = "home-intro-more";
    more.textContent = "全部能力开箱即用：注册一个账号，或让朋友把编辑链接发给你。";
    container.appendChild(more);
  }
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

  /** 顶栏"介绍"重开按钮（介绍被收起时显示；幂等） */
  const mountReopen = () => {
    if (safeStorage.get("ce-intro-dismissed") !== "1") return;
    if (header.querySelector(".home-intro-reopen")) return;
    const re = document.createElement("button");
    re.className = "btn home-intro-reopen";
    re.textContent = "ⓘ 介绍";
    re.title = "查看产品介绍";
    re.addEventListener("click", () => {
      safeStorage.remove("ce-intro-dismissed");
      location.reload();
    });
    header.appendChild(re);
  };

  const renderHeader = (logged: boolean, name?: string) => {
    header.innerHTML = `
      <div class="brand">协同编辑器<span class="brand-sub">Collab Editor</span></div>
      <div class="spacer"></div>`;
    // 介绍被收起时，顶栏保留重新展开的入口
    if (logged) mountReopen();
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
        <div class="home-hero-badge">多人实时协作</div>
        <h1>Collab Blocks</h1>
        <p class="home-hero-sub">基于块结构的协同文档：像腾讯文档一样分享链接实时协作，<br>底层是一套自研的同步协议（版本 + 块级 CAS，不依赖 OT/CRDT）。</p>
        <button class="btn home-cta">免费开始使用</button>
        <p class="home-dim">注册即可创建文档并分享协作；也可以直接打开别人分享给你的链接，以访客身份参与编辑。</p>
      </div>
      <section class="home-intro guest-intro"></section>`;
    main.querySelector<HTMLElement>(".home-cta")!.addEventListener("click", () => openAuthModal("register"));
    mountIntroCards(main.querySelector(".guest-intro")!, true);
    return;
  }

  const payload = (await res!.json()) as { docs: DocMeta[]; user: { name: string; isGuest: boolean } };
  const data = payload.docs;
  const me = payload.user?.isGuest ? `${payload.user.name}（访客）` : payload.user?.name ?? "我";
  renderHeader(true, me);

  // ---------------- 产品介绍（登录后也展示，可收起，偏好记忆在 localStorage） ----------------
  const intro = document.createElement("section");
  intro.className = "home-intro collapsible";
  const introDismissed = safeStorage.get("ce-intro-dismissed") === "1";
  {
    const head = document.createElement("div");
    head.className = "home-intro-head";
    head.innerHTML = `<div class="home-intro-title">📚 这是什么？<span>Collab Blocks · 多人实时协作的块结构编辑器</span></div>`;
    const body = document.createElement("div");
    body.className = "home-intro-body collapsible-body";
    mountIntroCards(body, false);
    const dismiss = document.createElement("button");
    dismiss.className = "btn home-intro-dismiss";
    dismiss.textContent = "收起";
    dismiss.title = "收起介绍";
    /** 平滑收起/展开：先测量实际高度，再过渡 max-height + opacity */
    const setCollapsed = (collapsed: boolean) => {
      if (collapsed) {
        body.style.maxHeight = `${body.scrollHeight}px`;
        requestAnimationFrame(() => {
          body.style.maxHeight = "0px";
          body.style.opacity = "0";
        });
        body.addEventListener("transitionend", () => {
          if (safeStorage.get("ce-intro-dismissed") === "1") intro.classList.add("gone");
        }, { once: true });
        safeStorage.set("ce-intro-dismissed", "1");
        dismiss.textContent = "展开";
        dismiss.title = "展开介绍";
        mountReopen(); // 收起动画期间顶栏入口就位
      } else {
        intro.classList.remove("gone");
        body.style.maxHeight = `${body.scrollHeight}px`;
        body.style.opacity = "1";
        body.addEventListener("transitionend", () => {
          body.style.maxHeight = ""; // 展开完成后解除限制，允许内容自适应
        }, { once: true });
        safeStorage.remove("ce-intro-dismissed");
        dismiss.textContent = "收起";
        dismiss.title = "收起介绍";
        header.querySelector(".home-intro-reopen")?.remove();
      }
    };
    dismiss.addEventListener("click", () => setCollapsed(safeStorage.get("ce-intro-dismissed") !== "1"));
    head.appendChild(dismiss);
    intro.appendChild(head);
    intro.appendChild(body);
    main.appendChild(intro);
    if (introDismissed) {
      // 刷新进入已收起态：无动画直接收
      body.style.transition = "none";
      body.style.maxHeight = "0px";
      body.style.opacity = "0";
      dismiss.textContent = "展开";
      dismiss.title = "展开介绍";
      requestAnimationFrame(() => (body.style.transition = ""));
    }
  }

  // 新建 + 回收站
  const bar = document.createElement("div");
  bar.className = "home-bar";
  bar.innerHTML = `<span class="home-bar-spacer"></span>`;
  const trashBtn = document.createElement("button");
  trashBtn.className = "btn home-trash";
  trashBtn.textContent = "回收站";
  trashBtn.title = "删除的文档保留 7 天";
  bar.appendChild(trashBtn);
  const importBtn = document.createElement("button");
  importBtn.className = "btn home-import";
  importBtn.textContent = "⇪ 导入 Markdown";
  importBtn.title = "上传 .md 文件生成新文档（标题/列表/待办/代码块）";
  bar.appendChild(importBtn);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".md,.markdown,text/markdown";
  fileInput.style.display = "none";
  bar.appendChild(fileInput);
  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert("文件过大（上限 10MB）");
      return;
    }
    try {
      const text = await file.text();
      const blocks = markdownToBlocks(text, () => uuid());
      const first = blocks[0];
      const title = first && (first.type === "h1" || first.type === "h2" || first.type === "h3") ? first.text : file.name.replace(/\.(md|markdown)$/i, "");
      const r = await fetch("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ title, blocks }),
      });
      const created = (await r.json()) as { docId?: string; error?: string };
      if (created.docId) location.href = `/d/${created.docId}`;
      else alert(created.error ?? "导入失败");
    } catch {
      alert("读取文件失败");
    }
  });
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
    meta.textContent = `${d.mine ? "我的" : "公开"} · v${d.version} · ${fmtTime(d.updatedAt)}`;
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
