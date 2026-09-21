/**
 * Search：全文搜索（标题+正文）。
 *
 * - Ctrl+F 或 🔍 按钮唤起；输入即时匹配（150ms 防抖），Enter/↑↓/按钮循环跳转；
 * - 高亮使用 CSS Custom Highlight API（::highlight，Chrome 105+），
 *   不改 DOM、不干扰协同渲染与光标；不支持的浏览器退化为"仅跳转"；
 * - 匹配区间的 Range 基于 .block-text 内文本节点定位。
 */
import type { DocModel } from "./model";
import type { Editor } from "./editor";

interface Match {
  blockId: string;
  start: number;
  end: number;
}

function locate(el: HTMLElement, offset: number): { node: Text | null; local: number } {
  let remaining = offset;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let last: Text | null = null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    last = t;
    if (t.length >= remaining) return { node: t, local: remaining };
    remaining -= t.length;
  }
  return { node: last, local: last ? last.length : 0 };
}

/** CSS Custom Highlight API 环境（不存在则退化为仅跳转；注意 Registry 不是 Map 实例，按鸭子类型判断） */
function highlightsRegistry(): { set(k: string, v: unknown): void; has(k: string): boolean; delete(k: string): boolean } | null {
  try {
    const h = (CSS as unknown as { highlights?: { set(k: string, v: unknown): void; has(k: string): boolean; delete(k: string): boolean } }).highlights;
    if (h && typeof h.set === "function" && typeof h.has === "function") return h;
  } catch {
    /* ignore */
  }
  return null;
}
function highlightCtor(): (new (...ranges: Range[]) => { add?: (r: Range) => void }) | null {
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => { add?: (r: Range) => void } }).Highlight;
  return H ?? null;
}

export class Search {
  private panel: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private countEl: HTMLElement | null = null;
  private matches: Match[] = [];
  private current = -1;
  private debounceTimer: number | null = null;
  private modelListener: () => void;

  constructor(
    private model: DocModel,
    private editor: Editor,
    private host: HTMLElement,
  ) {
    this.modelListener = () => {
      if (this.panel) this.recompute();
    };
    this.model.on(this.modelListener);
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  open() {
    if (this.panel) {
      this.input?.focus();
      this.input?.select();
      return;
    }
    const panel = document.createElement("div");
    panel.className = "search-panel";
    const input = document.createElement("input");
    input.className = "search-input";
    input.placeholder = "搜索文档内容…";
    const count = document.createElement("span");
    count.className = "search-count";
    const prev = document.createElement("button");
    prev.className = "btn search-nav";
    prev.textContent = "↑";
    prev.title = "上一个（Shift+Enter）";
    const next = document.createElement("button");
    next.className = "btn search-nav";
    next.textContent = "↓";
    next.title = "下一个（Enter）";
    const close = document.createElement("button");
    close.className = "btn search-nav";
    close.textContent = "×";
    close.title = "关闭（Esc）";
    panel.appendChild(input);
    panel.appendChild(count);
    panel.appendChild(prev);
    panel.appendChild(next);
    panel.appendChild(close);
    this.host.appendChild(panel);
    this.panel = panel;
    this.input = input;
    this.countEl = count;

    input.addEventListener("input", () => {
      if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => {
        this.debounceTimer = null;
        this.recompute();
      }, 150);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.jump(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    prev.addEventListener("click", () => this.jump(-1));
    next.addEventListener("click", () => this.jump(1));
    close.addEventListener("click", () => this.close());
    setTimeout(() => input.focus(), 30);
  }

  close() {
    this.clearHighlights();
    this.panel?.remove();
    this.panel = null;
    this.input = null;
    this.countEl = null;
    this.matches = [];
    this.current = -1;
  }

  private recompute() {
    const q = (this.input?.value ?? "").trim().toLowerCase();
    this.clearHighlights();
    this.matches = [];
    this.current = -1;
    if (q) {
      for (const b of this.model.blocks) {
        const text = b.text.toLowerCase();
        let idx = text.indexOf(q);
        while (idx !== -1) {
          this.matches.push({ blockId: b.id, start: idx, end: idx + q.length });
          idx = text.indexOf(q, idx + q.length);
        }
      }
    }
    if (this.countEl) {
      this.countEl.textContent = this.matches.length === 0 ? (q ? "无结果" : "") : `0/${this.matches.length}`;
    }
    if (this.matches.length > 0) {
      this.applyHighlights();
      this.jump(1);
    }
  }

  private rangeFor(m: Match): Range | null {
    const el = this.editor.textNodeOf?.(m.blockId);
    if (!el) return null;
    const a = locate(el, m.start);
    const b = locate(el, m.end);
    if (!a.node || !b.node) return null;
    const r = document.createRange();
    r.setStart(a.node, a.local);
    r.setEnd(b.node, b.local);
    return r;
  }

  private applyHighlights() {
    const CSSHigh = highlightsRegistry();
    const HighlightCtor = highlightCtor();
    if (!CSSHigh || !HighlightCtor) return; // 浏览器不支持：退化为仅跳转
    const all = new HighlightCtor();
    for (const m of this.matches) {
      const r = this.rangeFor(m);
      if (r) all.add?.(r);
    }
    CSSHigh.set("ce-search", all);
  }

  private clearHighlights() {
    highlightsRegistry()?.delete("ce-search");
    highlightsRegistry()?.delete("ce-search-current");
  }

  private highlightCurrent() {
    const CSSHigh = highlightsRegistry();
    const HighlightCtor = highlightCtor();
    if (!CSSHigh || !HighlightCtor || this.current < 0) return;
    const m = this.matches[this.current];
    const r = m ? this.rangeFor(m) : null;
    if (!r) return;
    const cur = new HighlightCtor(r);
    CSSHigh.set("ce-search-current", cur);
  }

  private jump(dir: 1 | -1) {
    if (this.matches.length === 0) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    const m = this.matches[this.current];
    this.editor.scrollToBlock(m.blockId);
    this.highlightCurrent();
    if (this.countEl) this.countEl.textContent = `${this.current + 1}/${this.matches.length}`;
  }
}
