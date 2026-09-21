/**
 * Share：分享面板 —— 复制编辑链接 / 只读链接；创建者可切换"仅创建者可编辑"。
 */
import { getToken } from "./auth";

function copyText(text: string): boolean {
  // clipboard API 需要安全上下文与焦点；降级 execCommand
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
  void navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  );
  return false;
}

export async function openShareModal(opts: {
  docId: string;
  isOwner: boolean;
  enforceOwnerEdit: boolean;
  onToast: (msg: string, kind?: "info" | "warn" | "error") => void;
}) {
  const { docId, isOwner, onToast } = opts;
  const metaRes = await fetch(`/api/docs/${docId}/meta`, { headers: { Authorization: `Bearer ${getToken()}` } });
  const meta = (await metaRes.json()) as { enforceOwnerEdit?: boolean; accessMode?: "open" | "auth" | "restricted" };
  let mode: "open" | "auth" | "restricted" = meta.accessMode ?? (meta.enforceOwnerEdit ? "restricted" : "open");

  const mask = document.createElement("div");
  mask.className = "modal-mask";
  const box = document.createElement("div");
  box.className = "share-modal";
  box.innerHTML = `
    <div class="share-head"><b>分享文档</b><button class="btn share-close">关闭</button></div>
    <div class="share-body">
      <div class="share-row">
        <span class="share-label">编辑链接</span>
        <input class="share-edit-url" readonly />
        <button class="btn share-copy-edit">复制</button>
      </div>
      <div class="share-row">
        <span class="share-label">只读链接</span>
        <input class="share-ro-url" readonly />
        <button class="btn share-copy-ro">复制</button>
      </div>
      <p class="share-hint">拿到编辑链接的人可以编辑；拿到只读链接的人只能查看（实时同步）。</p>
      ${
        isOwner
          ? `<div class="share-access">
               <div class="share-access-label">编辑权限</div>
               <div class="share-seg share-seg-3">
                 <button type="button" class="share-seg-item ${mode === "open" ? "active" : ""}" data-mode="open">🟢 开放</button>
                 <button type="button" class="share-seg-item ${mode === "auth" ? "active" : ""}" data-mode="auth">🔑 登录可编辑</button>
                 <button type="button" class="share-seg-item ${mode === "restricted" ? "active" : ""}" data-mode="restricted">🔒 受限</button>
               </div>
               <div class="share-access-desc"></div>
             </div>
             <div class="share-collab">
               <div class="share-collab-head">协作者名单（受限编辑模式下，名单内的人仍可编辑）</div>
               <div class="share-collab-list"></div>
               <div class="share-collab-add">
                 <input class="share-collab-input" placeholder="按用户名邀请…" maxlength="24" />
                 <button class="btn share-collab-btn">邀请</button>
               </div>
             </div>`
          : ""
      }
    </div>`;
  mask.appendChild(box);
  document.body.appendChild(mask);

  const editUrl = `${location.origin}/d/${docId}`;
  // 只读链接令牌：由服务器懒生成，通过专用接口取
  let roUrl = "";
  fetch(`/api/docs/${docId}/ro`, { headers: { Authorization: `Bearer ${getToken()}` } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no ro"))))
    .then((d: { token: string }) => {
      roUrl = `${location.origin}/r/${d.token}`;
      (box.querySelector(".share-ro-url") as HTMLInputElement).value = roUrl;
    })
    .catch(() => {
      (box.querySelector(".share-ro-url") as HTMLInputElement).value = "（生成失败，稍后再试）";
    });
  (box.querySelector(".share-edit-url") as HTMLInputElement).value = editUrl;

  const close = () => mask.remove();
  box.querySelector(".share-close")!.addEventListener("click", close);
  mask.addEventListener("click", (e) => {
    if (e.target === mask) close();
  });
  const bindCopy = (cls: string, urlGetter: () => string, label: string) => {
    box.querySelector(cls)!.addEventListener("click", () => {
      const url = urlGetter();
      if (!url || url.startsWith("（")) return;
      copyText(url);
      onToast(`${label}已复制`, "info");
    });
  };
  bindCopy(".share-copy-edit", () => editUrl, "编辑链接");
  bindCopy(".share-copy-ro", () => roUrl, "只读链接");

  // 三档权限选择器
  const descEl = box.querySelector<HTMLElement>(".share-access-desc");
  const syncAccessUI = () => {
    descEl!.textContent =
      mode === "open"
        ? "拿到编辑链接的任何人（含访客）都可编辑。"
        : mode === "auth"
          ? "注册登录的用户可编辑，访客只读。适合公开分享但不想被匿名改动。"
          : "仅创建者与协作者名单内的人可编辑，其他人（含已登录用户）也是只读。";
    box.querySelectorAll<HTMLButtonElement>(".share-seg-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
  };
  syncAccessUI();
  box.querySelectorAll<HTMLButtonElement>(".share-seg-item").forEach((b) => {
    b.addEventListener("click", async () => {
      const want = b.dataset.mode as "open" | "auth" | "restricted";
      if (want === mode) return;
      const prev = mode;
      mode = want;
      syncAccessUI();
      const res = await fetch(`/api/docs/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ accessMode: mode }),
      });
      if (res.ok) {
        const label = mode === "open" ? "开放编辑（任何人）" : mode === "auth" ? "登录可编辑（访客只读）" : "受限编辑（仅协作者）";
        onToast(`已切换为${label}`, "info");
      } else {
        mode = prev;
        syncAccessUI();
        onToast("设置失败", "error");
      }
    });
  });

  // ---------------- 协作者名单（创建者） ----------------
  const collabList = box.querySelector<HTMLElement>(".share-collab-list");
  const renderCollabs = async () => {
    if (!collabList) return;
    try {
      const res = await fetch(`/api/docs/${docId}/collaborators`, { headers: { Authorization: `Bearer ${getToken()}` } });
      const data = (await res.json()) as { collaborators: { userId: string; name: string; color: string }[] };
      collabList.innerHTML = "";
      if (data.collaborators.length === 0) {
        collabList.innerHTML = `<span class="share-hint">暂无协作者</span>`;
        return;
      }
      for (const c of data.collaborators) {
        const row = document.createElement("div");
        row.className = "share-collab-row";
        const dot = document.createElement("span");
        dot.className = "comment-dot";
        dot.style.background = c.color;
        const name = document.createElement("span");
        name.textContent = c.name;
        const del = document.createElement("button");
        del.className = "btn";
        del.textContent = "移除";
        del.addEventListener("click", async () => {
          await fetch(`/api/docs/${docId}/collaborators/${c.userId}`, { method: "DELETE", headers: { Authorization: `Bearer ${getToken()}` } });
          void renderCollabs();
        });
        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(del);
        collabList.appendChild(row);
      }
    } catch {
      collabList.innerHTML = `<span class="share-hint">加载失败</span>`;
    }
  };
  void renderCollabs();
  // 待审权限申请（owner）
  const reqSection = document.createElement("div");
  reqSection.className = "share-requests";
  const renderRequests = async () => {
    if (!isOwner) return;
    try {
      const res = await fetch(`/api/docs/${docId}/requests`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return;
      const data = (await res.json()) as { requests: { id: number; userName: string; message: string | null; createdAt: number }[] };
      reqSection.innerHTML = "";
      if (data.requests.length === 0) return;
      const head = document.createElement("div");
      head.className = "share-collab-head";
      head.textContent = `权限申请（${data.requests.length} 条待处理）`;
      reqSection.appendChild(head);
      for (const req of data.requests) {
        const row = document.createElement("div");
        row.className = "share-req-row";
        const info = document.createElement("div");
        info.className = "share-req-info";
        info.innerHTML = `<b></b><span></span>`;
        info.querySelector("b")!.textContent = req.userName;
        info.querySelector("span")!.textContent = req.message || "申请编辑权限";
        const approve = document.createElement("button");
        approve.className = "btn";
        approve.textContent = "同意";
        approve.addEventListener("click", async () => {
          await fetch(`/api/docs/${docId}/requests/${req.id}/approve`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` } });
          onToast(`已同意 ${req.userName} 的申请`, "info");
          void renderCollabs();
          void renderRequests();
        });
        const reject = document.createElement("button");
        reject.className = "btn";
        reject.textContent = "拒绝";
        reject.addEventListener("click", async () => {
          await fetch(`/api/docs/${docId}/requests/${req.id}/reject`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` } });
          void renderRequests();
        });
        row.appendChild(info);
        row.appendChild(approve);
        row.appendChild(reject);
        reqSection.appendChild(row);
      }
    } catch { /* 静默 */ }
  };
  void renderRequests();
  const body = box.querySelector(".share-body");
  if (body && isOwner) body.appendChild(reqSection);

  const collabInput = box.querySelector<HTMLInputElement>(".share-collab-input");
  const addCollab = async () => {
    const username = collabInput?.value.trim() ?? "";
    if (!username) return;
    const res = await fetch(`/api/docs/${docId}/collaborators`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ username }),
    });
    const data = (await res.json()) as { error?: string };
    if (res.ok) {
      onToast(`已邀请 ${username}`, "info");
      if (collabInput) collabInput.value = "";
      void renderCollabs();
    } else {
      onToast(data.error ?? "邀请失败", "error");
    }
  };
  box.querySelector(".share-collab-btn")?.addEventListener("click", () => void addCollab());
  collabInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addCollab();
    }
  });
}
