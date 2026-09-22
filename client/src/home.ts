/**
 * Home：文档首页 —— 我的文档列表（新建/打开/改名/删除）。
 * 纯 REST 页面（无 WebSocket）；访客显示登录引导（访客通过分享链接参与编辑）。
 */
import { getToken, openAuthModal, logout } from "./auth";
import { markdownToBlocks } from "./markdown";
import { safeStorage } from "./util";
import { DOC_ID, HELP_DOC_ID, uuid } from "@shared/protocol";

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
        <div class="home-hero-badge">多人实时协作</div>
        <h1>Collab Blocks</h1>
        <p class="home-hero-sub">基于块结构的协同文档：像腾讯文档一样分享链接实时协作，<br>底层是一套自研的同步协议（版本 + 块级 CAS，不依赖 OT/CRDT）。</p>
        <div class="home-hero-actions">
          <button class="btn home-cta">免费开始使用</button>
          <a class="btn" href="/d/${DOC_ID}">🎮 演示文档</a>
          <a class="btn" href="/d/${HELP_DOC_ID}">📖 功能说明（只读）</a>
        </div>
        <div class="home-hero-tips">
          <div class="home-hero-tip">
            <span class="home-hero-tip-icon">✍️</span>
            <span><b>注册登录</b> 创建文档，分享链接邀请协作</span>
          </div>
          <div class="home-hero-tip-divider"></div>
          <div class="home-hero-tip">
            <span class="home-hero-tip-icon">🔗</span>
            <span><b>打开分享链接</b> 即可以访客身份参与编辑</span>
          </div>
        </div>
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

  // ---------------- 产品介绍（登录后也展示，同一头部按钮收放，平滑高度过渡） ----------------
  const intro = document.createElement("section");
  intro.className = "home-intro";
  const introDismissed = safeStorage.get("ce-intro-dismissed") === "1";
  {
    const head = document.createElement("div");
    head.className = "home-intro-head";
    head.innerHTML = `<div class="home-intro-title">📚 这是什么？<span>Collab Blocks · 多人实时协作的块结构编辑器</span></div>`;
    const body = document.createElement("div");
    body.className = "home-intro-body";
    mountIntroCards(body, false);
    const toggle = document.createElement("button");
    toggle.className = "btn home-intro-toggle";
    toggle.innerHTML = `<span class="toggle-text">收起介绍</span><span class="toggle-arrow">▾</span>`;
    /** 同一按钮收/放：整块 max-height + opacity 过渡，头部行始终可见 */
    const setCollapsed = (collapsed: boolean, instant = false) => {
      if (instant) (intro as HTMLElement).style.transition = "none";
      intro.classList.toggle("collapsed", collapsed);
      toggle.querySelector(".toggle-text")!.textContent = collapsed ? "展开介绍" : "收起介绍";
      (toggle.querySelector(".toggle-arrow") as HTMLElement)!.style.transform = collapsed ? "rotate(-90deg)" : "";
      if (collapsed) {
        safeStorage.set("ce-intro-dismissed", "1");
      } else {
        safeStorage.remove("ce-intro-dismissed");
      }
      if (instant) requestAnimationFrame(() => ((intro as HTMLElement).style.transition = ""));
    };
    toggle.addEventListener("click", () => setCollapsed(!intro.classList.contains("collapsed")));
    head.appendChild(toggle);
    intro.appendChild(head);
    intro.appendChild(body);
    main.appendChild(intro);
    if (introDismissed) setCollapsed(true, true);
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
  importBtn.title = "上传 .md / .txt 文件生成新文档";
  bar.appendChild(importBtn);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".md,.markdown,.txt,text/markdown,text/plain";
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
      const isTxt = /\.txt$/i.test(file.name);
      const blocks = isTxt
        ? text.split(/\n\s*\n/).filter((p) => p.trim()).map((p) => ({ id: uuid(), type: "text" as const, text: p.trim() }))
        : markdownToBlocks(text, () => uuid());
      if (blocks.length === 0) blocks.push({ id: uuid(), type: "text", text: "" });
      const first = blocks[0];
      const title = first && (first.type === "h1" || first.type === "h2" || first.type === "h3") ? first.text : file.name.replace(/\.(md|markdown|txt)$/i, "");
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
  newBtn.addEventListener("click", () => openTemplatePicker());
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

// ---------------------------------------------------------------- 模板

interface DocTemplate {
  id: string;
  name: string;
  icon: string;
  desc: string;
  blocks: { type: string; text: string; checked?: boolean }[];
}

const TEMPLATES: DocTemplate[] = [
  { id: "blank", name: "空白文档", icon: "📄", desc: "从零开始", blocks: [{ type: "h1", text: "未命名文档" }] },
  {
    id: "meeting", name: "会议纪要", icon: "📋", desc: "议题 / 决议 / 待办",
    blocks: [
      { type: "h1", text: "会议纪要" },
      { type: "h2", text: "基本信息" },
      { type: "bullet", text: "时间：" },
      { type: "bullet", text: "参会人：" },
      { type: "h2", text: "议题与讨论" },
      { type: "text", text: "" },
      { type: "h2", text: "决议" },
      { type: "bullet", text: "" },
      { type: "h2", text: "待办" },
      { type: "todo", text: "", checked: false },
    ],
  },
  {
    id: "todo", name: "待办清单", icon: "✅", desc: "任务与进度",
    blocks: [
      { type: "h1", text: "待办清单" },
      { type: "todo", text: "第一个任务", checked: false },
      { type: "todo", text: "第二个任务", checked: false },
    ],
  },
  {
    id: "weekly", name: "周报", icon: "📊", desc: "本周 / 下周",
    blocks: [
      { type: "h1", text: "周报" },
      { type: "h2", text: "本周完成" },
      { type: "bullet", text: "" },
      { type: "h2", text: "下周计划" },
      { type: "bullet", text: "" },
    ],
  },
];

function openTemplatePicker() {
  document.querySelector(".template-modal")?.remove();
  const mask = document.createElement("div");
  mask.className = "modal-mask template-modal";
  const box = document.createElement("div");
  box.className = "template-box";
  box.innerHTML = '<div class="share-head"><b>选择模板</b><button class="btn tpl-close">关闭</button></div><div class="template-grid"></div>';
  mask.appendChild(box);
  document.body.appendChild(mask);
  box.querySelector(".tpl-close")!.addEventListener("click", () => mask.remove());
  mask.addEventListener("click", (e) => {
    if (e.target === mask) mask.remove();
  });
  const grid = box.querySelector(".template-grid")!;
  for (const tpl of TEMPLATES) {
    const card = document.createElement("button");
    card.className = "template-card";
    card.innerHTML = '<div class="template-icon"></div><h3></h3><p></p>';
    card.querySelector(".template-icon")!.textContent = tpl.icon;
    card.querySelector("h3")!.textContent = tpl.name;
    card.querySelector("p")!.textContent = tpl.desc;
    card.addEventListener("click", async () => {
      const blocks = tpl.blocks.map((b) => ({ ...b, id: uuid() }));
      const r = await fetch("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ title: tpl.blocks[0]?.text ?? tpl.name, blocks }),
      });
      const created = (await r.json()) as { docId?: string; error?: string };
      if (created.docId) location.href = `/d/${created.docId}`;
      else alert(created.error ?? "创建失败");
    });
    grid.appendChild(card);
  }
}
