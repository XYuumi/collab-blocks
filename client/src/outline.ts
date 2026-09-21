/**
 * Outline：大纲导航 —— 从标题块（h1/h2/h3）实时生成目录，点击平滑滚动，
 * 滚动时高亮当前章节。可折叠，小屏隐藏。
 */
import type { DocModel } from "./model";
import type { Editor } from "./editor";

export class Outline {
  readonly el: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLElement;
  private items: { id: string; level: number; text: string }[] = [];
  private collapsed = false;
  private scrollTimer: number | null = null;

  constructor(
    private model: DocModel,
    private editor: Editor,
    host: HTMLElement,
  ) {
    const wrap = document.createElement("aside");
    wrap.className = "outline";
    this.el = wrap;
    this.toggleBtn = document.createElement("button");
    this.toggleBtn.className = "btn outline-toggle";
    this.toggleBtn.textContent = "☰";
    this.toggleBtn.title = "展开/收起大纲";
    this.listEl = document.createElement("div");
    this.listEl.className = "outline-list";
    wrap.appendChild(this.toggleBtn);
    wrap.appendChild(this.listEl);
    host.appendChild(wrap);

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.model.on((e) => {
      if (e.kind === "text" || e.kind === "structure") this.renderSoon();
    });
    window.addEventListener(
      "scroll",
      () => {
        if (this.scrollTimer !== null) return;
        this.scrollTimer = window.setTimeout(() => {
          this.scrollTimer = null;
          this.updateActive();
        }, 200);
      },
      { passive: true },
    );
    this.render();
  }

  /** 大文档下每次文本事件全量重建浪费：300ms 防抖 */
  private renderTimer: number | null = null;
  private renderSoon() {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 300);
  }

  toggle() {
    this.collapsed = !this.collapsed;
    this.el.classList.toggle("collapsed", this.collapsed);
  }

  render() {
    this.items = this.editor.headings();
    this.listEl.innerHTML = "";
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "用 h1/h2/h3 标题组织文档，这里会生成大纲";
      this.listEl.appendChild(empty);
      return;
    }
    for (const it of this.items) {
      const item = document.createElement("div");
      item.className = `outline-item outline-l${it.level}`;
      item.textContent = it.text.slice(0, 30);
      item.title = it.text;
      item.addEventListener("click", () => this.editor.scrollToBlock(it.id));
      this.listEl.appendChild(item);
    }
    this.updateActive();
  }

  private updateActive() {
    const nodes = [...this.listEl.querySelectorAll<HTMLElement>(".outline-item")];
    if (nodes.length === 0) return;
    let activeIdx = 0;
    for (let i = 0; i < this.items.length; i++) {
      const blockEl = document.querySelector(`.block[data-id="${this.items[i].id}"]`);
      if (blockEl && blockEl.getBoundingClientRect().top < window.innerHeight * 0.25) {
        activeIdx = i;
      }
    }
    nodes.forEach((n, i) => n.classList.toggle("active", i === activeIdx));
  }
}
