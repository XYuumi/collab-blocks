/**
 * SnapshotViewer：历史快照的只读查看 + 恢复到指定版本（doc.replace 事务）。
 * 数据来自 GET /api/docs/:docId/snapshots 与 .../:version。
 */
import type { BlockData, DocSnapshot } from "@shared/protocol";

interface SnapshotMeta {
  version: number;
  ts: number;
}

export class SnapshotViewer {
  private modal: HTMLElement | null = null;
  lastViewedVersion = 0;

  constructor(
    private docId: string,
    private opts: {
      canRestore: boolean;
      onRestore: (blocks: BlockData[]) => void;
    },
  ) {}

  async open() {
    this.close();
    const modal = document.createElement("div");
    modal.className = "modal-mask";
    modal.innerHTML = `<div class="modal"><div class="modal-head"><b>历史快照</b><span class="modal-head-actions"></span></div><div class="modal-body"><div class="snap-list">加载中…</div><div class="snap-view"><p class="snap-hint">选择左侧一个版本查看只读内容</p></div></div></div>`;
    document.body.appendChild(modal);
    this.modal = modal;

    const actions = modal.querySelector<HTMLElement>(".modal-head-actions")!;
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn";
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", () => this.close());
    actions.appendChild(closeBtn);
    if (this.opts.canRestore) {
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "btn snap-restore";
      restoreBtn.textContent = "恢复到此版本";
      restoreBtn.style.display = "none";
      restoreBtn.addEventListener("click", () => {
        if (!this.lastViewedVersion) return;
        if (!confirm(`恢复到版本 v${this.lastViewedVersion}？当前内容会被替换（可撤销）。`)) return;
        const view = modal.querySelector<HTMLElement>(".snap-view")!;
        const blocks = [...view.querySelectorAll<HTMLElement>(".snap-block")] as HTMLElement[];
        void blocks;
        this.opts.onRestore(this.lastViewedBlocks);
        this.close();
      });
      actions.appendChild(restoreBtn);
      this.restoreBtn = restoreBtn;
    }

    modal.addEventListener("click", (e) => {
      if (e.target === modal) this.close();
    });

    const list = modal.querySelector<HTMLElement>(".snap-list")!;
    try {
      const res = await fetch(`/api/docs/${this.docId}/snapshots`);
      const metas = (await res.json()) as SnapshotMeta[];
      if (metas.length === 0) {
        list.innerHTML = "<p>暂无快照（每 50 个版本自动生成一个）</p>";
        return;
      }
      list.innerHTML = "";
      for (const m of metas) {
        const item = document.createElement("button");
        item.className = "snap-item";
        item.innerHTML = `<b>v${m.version}</b><span>${new Date(m.ts).toLocaleString()}</span>`;
        item.addEventListener("click", () => this.showVersion(m.version, modal));
        list.appendChild(item);
      }
    } catch {
      list.innerHTML = "<p>加载失败（需要连接服务器）</p>";
    }
  }

  private restoreBtn: HTMLElement | null = null;
  private lastViewedBlocks: BlockData[] = [];

  private async showVersion(version: number, modal: HTMLElement) {
    const view = modal.querySelector<HTMLElement>(".snap-view")!;
    view.innerHTML = "<p>加载中…</p>";
    const items = modal.querySelectorAll<HTMLElement>(".snap-item");
    items.forEach((el) => el.classList.remove("active"));
    try {
      const res = await fetch(`/api/docs/${this.docId}/snapshots/${version}`);
      if (!res.ok) throw new Error();
      const doc = (await res.json()) as DocSnapshot;
      view.innerHTML = `<p class="snap-hint">版本 v${doc.version}（只读预览）</p>`;
      for (const b of doc.blocks) {
        const div = document.createElement("div");
        div.className = "snap-block";
        div.textContent = b.text || "（空块）";
        view.appendChild(div);
      }
      this.lastViewedVersion = doc.version;
      this.lastViewedBlocks = doc.blocks;
      if (this.restoreBtn) this.restoreBtn.style.display = "";
    } catch {
      view.innerHTML = "<p>加载失败</p>";
    }
    const target = [...items].find((el) => el.querySelector("b")?.textContent === `v${version}`);
    target?.classList.add("active");
  }

  close() {
    this.modal?.remove();
    this.modal = null;
    this.restoreBtn = null;
    this.lastViewedBlocks = [];
    this.lastViewedVersion = 0;
  }
}
