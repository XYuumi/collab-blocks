/**
 * SnapshotViewer：历史快照的只读查看 + 恢复到指定版本（doc.replace 事务）+ 与当前的对比视图。
 * 数据来自 GET /api/docs/:docId/snapshots 与 .../:version。
 */
import type { BlockData, DocSnapshot } from "@shared/protocol";
import { diffBlocks } from "./diffutil";

interface SnapshotMeta {
  version: number;
  ts: number;
}

export class SnapshotViewer {
  private modal: HTMLElement | null = null;
  lastViewedVersion = 0;
  private lastBlocks: BlockData[] = [];
  private diffMode = false;

  constructor(
    private docId: string,
    private opts: {
      canRestore: boolean;
      onRestore: (blocks: BlockData[]) => void;
      currentBlocks: () => BlockData[];
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
    if (this.opts.canRestore) {
      const restoreBtn = document.createElement("button");
      restoreBtn.className = "btn snap-restore";
      restoreBtn.textContent = "恢复到此版本";
      restoreBtn.style.display = "none";
      restoreBtn.addEventListener("click", () => {
        if (!this.lastViewedVersion) return;
        if (!confirm(`恢复到版本 v${this.lastViewedVersion}？当前内容会被替换（可撤销）。`)) return;
        this.opts.onRestore(this.lastBlocks);
        this.close();
      });
      actions.appendChild(restoreBtn);
      this.restoreBtn = restoreBtn;
    }
    const diffBtn = document.createElement("button");
    diffBtn.className = "btn snap-diff-toggle";
    diffBtn.textContent = "与当前对比";
    diffBtn.style.display = "none";
    diffBtn.addEventListener("click", () => {
      this.diffMode = !this.diffMode;
      diffBtn.textContent = this.diffMode ? "查看原文" : "与当前对比";
      diffBtn.classList.toggle("active", this.diffMode);
      this.renderView(modal);
    });
    actions.appendChild(diffBtn);
    this.diffBtn = diffBtn;
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn";
    closeBtn.textContent = "关闭";
    closeBtn.addEventListener("click", () => this.close());
    actions.appendChild(closeBtn);

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
  private diffBtn: HTMLElement | null = null;

  private async showVersion(version: number, modal: HTMLElement) {
    this.diffMode = false;
    if (this.diffBtn) {
      this.diffBtn.textContent = "与当前对比";
      this.diffBtn.classList.remove("active");
    }
    const view = modal.querySelector<HTMLElement>(".snap-view")!;
    view.innerHTML = "<p>加载中…</p>";
    const items = modal.querySelectorAll<HTMLElement>(".snap-item");
    items.forEach((el) => el.classList.remove("active"));
    try {
      const res = await fetch(`/api/docs/${this.docId}/snapshots/${version}`);
      if (!res.ok) throw new Error();
      const doc = (await res.json()) as DocSnapshot;
      this.lastViewedVersion = doc.version;
      this.lastBlocks = doc.blocks;
      this.renderView(modal);
      if (this.restoreBtn) this.restoreBtn.style.display = "";
      if (this.diffBtn) this.diffBtn.style.display = "";
    } catch {
      view.innerHTML = "<p>加载失败</p>";
    }
    const target = [...items].find((el) => el.querySelector("b")?.textContent === `v${version}`);
    target?.classList.add("active");
  }

  /** 按当前模式渲染：原文 或 与当前版本的逐块/逐字符 diff */
  private renderView(modal: HTMLElement) {
    const view = modal.querySelector<HTMLElement>(".snap-view")!;
    if (!this.lastViewedVersion) return;
    if (!this.diffMode) {
      view.innerHTML = `<p class="snap-hint">版本 v${this.lastViewedVersion}（只读预览）</p>`;
      for (const b of this.lastBlocks) {
        const div = document.createElement("div");
        div.className = "snap-block";
        div.textContent = b.text || "（空块）";
        view.appendChild(div);
      }
      return;
    }
    const rows = diffBlocks(this.lastBlocks, this.opts.currentBlocks());
    view.innerHTML = `<p class="snap-hint">v${this.lastViewedVersion} → 当前（<span class="diff-legend-del">删除</span> / <span class="diff-legend-ins">新增</span>）</p>`;
    let changes = 0;
    for (const row of rows) {
      const div = document.createElement("div");
      div.className = `diff-row diff-${row.kind}`;
      const mark = document.createElement("span");
      mark.className = "diff-mark";
      mark.textContent = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : row.kind === "changed" ? "~" : " ";
      div.appendChild(mark);
      if (row.kind === "changed") {
        for (const seg of row.segs) {
          const span = document.createElement("span");
          if (seg.kind === "del") span.className = "diff-del";
          else if (seg.kind === "ins") span.className = "diff-ins";
          span.textContent = seg.text;
          div.appendChild(span);
        }
      } else {
        div.appendChild(document.createTextNode(row.text || "（空块）"));
      }
      if (row.kind !== "same") changes++;
      view.appendChild(div);
    }
    if (changes === 0) {
      const hint = document.createElement("p");
      hint.className = "snap-hint";
      hint.textContent = "与当前内容完全一致";
      view.appendChild(hint);
    }
  }

  close() {
    this.modal?.remove();
    this.modal = null;
    this.restoreBtn = null;
    this.diffBtn = null;
    this.lastBlocks = [];
    this.lastViewedVersion = 0;
    this.diffMode = false;
  }
}
