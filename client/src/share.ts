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
  // 只读令牌需要时懒生成：通过 meta 读取不到时由服务器在首次分享时创建——
  // 这里直接请求 ro 链接（服务器端 readOnlyToken 懒生成），用 meta 接口带出
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
          ? `<label class="share-toggle"><input type="checkbox" class="share-enforce" ${enforce ? "checked" : ""}/> 仅创建者可编辑（其他人打开编辑链接也变为只读）</label>`
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
    if (res.ok) onToast(enforce ? "已开启：仅创建者可编辑" : "已关闭：拿到编辑链接的人都可编辑", "info");
    else onToast("设置失败", "error");
  });
}
