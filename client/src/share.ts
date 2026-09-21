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
  const meta = (await metaRes.json()) as { enforceOwnerEdit?: boolean };
  let enforce = opts.enforceOwnerEdit || !!meta.enforceOwnerEdit;

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
          ? `<label class="share-toggle"><input type="checkbox" class="share-enforce" ${enforce ? "checked" : ""}/> 仅创建者可编辑（协作者名单内的人除外）</label>
             <div class="share-collab">
               <div class="share-collab-head">协作者名单（开启上面开关后，名单内的人仍可编辑）</div>
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

  const enforceBox = box.querySelector<HTMLInputElement>(".share-enforce");
  enforceBox?.addEventListener("change", async () => {
    enforce = enforceBox.checked;
    const res = await fetch(`/api/docs/${docId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ enforceOwnerEdit: enforce }),
    });
    if (res.ok) onToast(enforce ? "已开启：仅创建者与协作者可编辑" : "已关闭：拿到编辑链接的人都可编辑", "info");
    else onToast("设置失败", "error");
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
