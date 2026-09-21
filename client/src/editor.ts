/**
 * Editor：DOM 渲染与输入捕获。
 *
 * 渲染策略（为什么不用框架重渲染）：
 * - 每个 Block 一个常驻 DOM 节点（按 data-id 索引），文本更新只写单个块的
 *   textContent 并保存/恢复光标；结构更新复用已有节点做移动/增删——
 *   避免 React/Vue 式重渲染破坏 contenteditable 的光标与 IME 状态。
 * - 块类型（标题/列表/待办/代码）：类型变化时按需重建该块节点（保留光标），
 *   其余块不受影响。
 * - 输入捕获：不劫持 beforeinput，而是在 input 事件后对新旧文本做前后缀 diff
 *   推导出 insert/delete op（保留原生输入法/快捷键行为）。
 * - IME：composition 期间不写该块 DOM（避免打断组词），compositionend 后统一 diff。
 * - 结构调和后同步所有块的文本（修复：重连对账/冲突重建后 DOM 陈旧的问题）。
 */
import type { BlockType, Op } from "@shared/protocol";
import { diffText, uuid } from "@shared/protocol";
import type { DocModel } from "./model";
import type { TxQueue } from "./queue";
import type { SelectionPoint, UndoManager } from "./undo";
import { caretShift, clamp } from "./util";

export interface LockRenderInfo {
  holder: { userId: string; name: string; color: string } | null;
  enforced: boolean;
}

export interface EditorHooks {
  onCursor: (blockId: string, offset: number, focusOffset?: number, focusBlockId?: string) => void;
  onFocusBlock: (blockId: string) => void;
  onBlurBlock: (blockId: string) => void;
  onStructureChanged: () => void;
  /** 轻提示（块 ID 复制等），可选 */
  onToast?: (msg: string, kind?: "info" | "warn" | "error") => void;
  /** 点击块上的评论气泡（可选） */
  onOpenComments?: (blockId: string) => void;
}

export interface SlashItem {
  type: BlockType;
  label: string;
  hint: string;
  /** 过滤别名（拼音/英文/同义词），如 /todo、/check 均可匹配"待办事项" */
  keys: string[];
}

const SLASH_ITEMS: SlashItem[] = [
  { type: "text", label: "正文", hint: "普通段落", keys: ["text", "p", "para", "wenzheng", "zhengwen"] },
  { type: "h1", label: "标题一", hint: "大标题", keys: ["h1", "t1", "biaoti", "title", "heading"] },
  { type: "h2", label: "标题二", hint: "中标题", keys: ["h2", "t2", "biaoti", "title"] },
  { type: "h3", label: "标题三", hint: "小标题", keys: ["h3", "t3", "biaoti", "title"] },
  { type: "bullet", label: "无序列表", hint: "圆点列表", keys: ["bullet", "list", "ul", "liebiao", "列表"] },
  { type: "todo", label: "待办事项", hint: "可勾选任务", keys: ["todo", "check", "checkbox", "daiban", "勾选", "任务", "task"] },
  { type: "code", label: "代码块", hint: "等宽字体", keys: ["code", "daima", "代码", "pre", "mono"] },
];

/** Markdown 快捷输入：在空块键入触发串即转换块类型（Notion 式） */
const MARKDOWN_TRIGGERS: { re: RegExp; type: BlockType; checked?: boolean }[] = [
  { re: /^# $/, type: "h1" },
  { re: /^## $/, type: "h2" },
  { re: /^### $/, type: "h3" },
  { re: /^[-*+] $/, type: "bullet" },
  { re: /^\[\] $/, type: "todo", checked: false },
  { re: /^\[ \] $/, type: "todo", checked: false },
  { re: /^\[[xX]\] $/, type: "todo", checked: true },
  { re: /^```$/, type: "code" },
];

// ------------------------------------------------------------------ 光标工具

export function getCaretOffset(el: HTMLElement): number | null {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

export function setCaretOffset(el: HTMLElement, offset: number) {
  const sel = getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = clamp(offset, 0, Number.MAX_SAFE_INTEGER);

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let lastText: Text | null = null;
  let placed = false;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    lastText = t;
    if (t.length >= remaining) {
      range.setStart(t, remaining);
      placed = true;
      break;
    }
    remaining -= t.length;
  }
  if (!placed) {
    if (lastText) range.setStart(lastText, lastText.length);
    else range.setStart(el, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 在块内定位 offset → (文本节点, 节点内偏移)；越界落到末尾 */
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

/** 指定块内某 offset 的屏幕矩形（远程光标/菜单定位用；行尾/空块有兜底） */
export function rectAtOffset(el: HTMLElement, offset: number): DOMRect | null {
  const range = document.createRange();
  const { node, local } = locate(el, offset);
  if (node) {
    range.setStart(node, local);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(true);
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    const br = el.getBoundingClientRect();
    return new DOMRect(br.left, br.top, 0, br.height || 24);
  }
  return rect;
}

// ------------------------------------------------------------------ Editor

export class Editor {
  readonly el: HTMLElement;
  private nodes = new Map<string, HTMLElement>(); // blockId → .block（外层容器）
  private composingBlockId: string | null = null;
  lockInfoProvider: ((blockId: string) => LockRenderInfo | undefined) | null = null;
  /** 评论计数提供者：块 → 未解决评论数（0 隐藏气泡） */
  commentsProvider: ((blockId: string) => number) | null = null;
  /** "/" 唤起的块类型菜单状态 */
  private slash: { blockId: string; el: HTMLElement; active: number } | null = null;
  /** 只读模式（viewer / 只读链接）：禁一切编辑入口 */
  readOnly = false;
  /** 正在拖拽的块 id */
  private draggingId: string | null = null;
  private dropLine: HTMLElement | null = null;

  /** 某块当前后面的块 id（null=末尾） */
  private nextIdOf(id: string): string | null {
    const i = this.model.blockIndex(id);
    return i >= 0 && i < this.model.blocks.length - 1 ? this.model.blocks[i + 1].id : null;
  }

  /** 依据指针位置计算落点：目标块上半=移到其前(beforeId=目标)，下半=移到其后(beforeId=目标的下一块) */
  private dropPlan(target: HTMLElement | null, clientY: number): { beforeId: string | null } | null {
    if (!target?.dataset.id) return null;
    const targetId = target.dataset.id;
    if (targetId === this.draggingId) return null;
    const rect = target.getBoundingClientRect();
    const before = clientY < rect.top + rect.height / 2;
    if (before) return { beforeId: targetId };
    return { beforeId: this.nextIdOf(targetId) };
  }

  private updateDropIndicator(target: HTMLElement | null, clientY: number) {
    const plan = this.dropPlan(target, clientY);
    this.clearDropIndicator();
    if (!plan || !target) return;
    const host = this.container.getBoundingClientRect();
    const anchorEl = plan.beforeId ? this.nodes.get(plan.beforeId) : null;
    const line = document.createElement("div");
    line.className = "drop-indicator";
    if (anchorEl) {
      const ar = anchorEl.getBoundingClientRect();
      line.style.left = `${ar.left}px`;
      line.style.width = `${ar.width}px`;
      line.style.top = `${ar.top - host.top - 2}px`;
    } else {
      const lastWrap = this.nodes.get(this.model.blocks[this.model.blocks.length - 1]?.id ?? "");
      const r = (lastWrap ?? target).getBoundingClientRect();
      line.style.left = `${r.left}px`;
      line.style.width = `${r.width}px`;
      line.style.top = `${r.bottom - host.top + 1}px`;
    }
    this.container.appendChild(line);
    this.dropLine = line;
  }

  private clearDropIndicator() {
    this.dropLine?.remove();
    this.dropLine = null;
  }

  setReadOnly(v: boolean) {
    this.readOnly = v;
    this.el.classList.toggle("readonly", v);
    if (v) this.closeSlashMenu();
    this.renderLocks();
  }

  /** 大纲跳转：平滑滚动到指定块 */
  scrollToBlock(blockId: string) {
    this.nodes.get(blockId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 大纲数据源：标题块列表 */
  headings(): { id: string; level: number; text: string }[] {
    return this.model.blocks
      .filter((b) => b.type === "h1" || b.type === "h2" || b.type === "h3")
      .map((b) => ({ id: b.id, level: Number(b.type.slice(1)), text: b.text }))
      .filter((h) => h.text.trim().length > 0);
  }

  constructor(
    private container: HTMLElement,
    private model: DocModel,
    private queue: TxQueue,
    private undoMgr: UndoManager,
    private hooks: EditorHooks,
  ) {
    this.el = document.createElement("div");
    this.el.className = "editor";
    container.appendChild(this.el);
    this.bindEvents();
  }

  // ------------------------------------------------------------- 渲染调和

  reconcileStructure() {
    const editorEl = this.el;
    const seen = new Set<string>();
    let ref: ChildNode | null = null; // 从后往前对齐
    for (let i = this.model.blocks.length - 1; i >= 0; i--) {
      const block = this.model.blocks[i];
      seen.add(block.id);
      let node = this.nodes.get(block.id);
      if (node && node.dataset.type !== block.type) {
        // 类型变化：重建该块节点（保留光标）
        const textEl = this.textNodeOf(block.id);
        const caret = textEl && document.activeElement === textEl ? getCaretOffset(textEl) : null;
        const fresh = this.createBlockNode(block.id);
        node.replaceWith(fresh);
        this.nodes.set(block.id, fresh);
        node = fresh;
        if (caret !== null) this.focusBlock(block.id, caret);
      } else if (!node) {
        node = this.createBlockNode(block.id);
        this.nodes.set(block.id, node);
      }
      if (node.parentElement !== editorEl || node.nextSibling !== ref) {
        editorEl.insertBefore(node, ref);
      }
      ref = node;
    }
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }
    // 关键：结构调和后同步所有块的文本与勾选态——
    // 重连对账/冲突重建只发结构事件，若不同步文本会显示陈旧内容（已修复的 bug）
    for (const b of this.model.blocks) {
      this.syncBlockDom(b.id);
    }
    this.closeSlashMenu();
    this.renderLocks();
    this.renderCommentChips();
    this.hooks.onStructureChanged();
  }

  /** 渲染块上的 💬 评论气泡（未解决评论数） */
  renderCommentChips() {
    if (!this.commentsProvider) return;
    for (const [id, wrap] of this.nodes) {
      let chip = wrap.querySelector<HTMLElement>(".block-comments-chip");
      const n = this.commentsProvider(id);
      if (n > 0) {
        if (!chip) {
          chip = document.createElement("button");
          chip.className = "block-comments-chip";
          chip.title = "查看该块的评论";
          chip.addEventListener("mousedown", (e) => {
            e.preventDefault(); // 不抢编辑焦点
            this.hooks.onOpenComments?.(id);
          });
          wrap.appendChild(chip);
        }
        chip.textContent = `💬 ${n}`;
      } else {
        chip?.remove();
      }
    }
  }

  private createBlockNode(id: string): HTMLElement {
    const block = this.model.block(id);
    const type = block?.type ?? "text";
    const wrap = document.createElement("div");
    wrap.className = `block block--${type}`;
    wrap.dataset.id = id;
    wrap.dataset.type = type;
    if (block?.checked) wrap.classList.add("checked");

    if (type === "image") {
      const img = document.createElement("img");
      img.className = "block-image";
      img.src = block?.src ?? "";
      img.alt = block?.text || "图片";
      img.draggable = false;
      wrap.appendChild(img);
      const del = document.createElement("button");
      del.className = "block-image-del";
      del.textContent = "×";
      del.title = "删除图片";
      del.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (this.readOnly) return;
        const cur = this.model.block(id);
        if (!cur) return;
        const idx = this.model.blockIndex(id);
        const prevId = idx > 0 ? this.model.blocks[idx - 1].id : null;
        this.queue.submitImmediate(
          [{ type: "block.delete", id, text: cur.text, prevId, blockType: "image", src: cur.src }],
          { selBefore: null },
        );
      });
      wrap.appendChild(del);
    } else {
      const text = document.createElement("div");
      text.className = "block-text";
      text.contentEditable = "plaintext-only";
      text.dataset.id = id;
      text.spellcheck = false;
      text.textContent = block?.text ?? "";
      text.dataset.empty = block?.text ? "" : "true";
      wrap.appendChild(text);
    }

    if (type === "todo") {
      const cb = document.createElement("div");
      cb.className = "block-checkbox" + (block?.checked ? " on" : "");
      cb.title = "点击切换完成状态";
      cb.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 不抢编辑焦点
        this.toggleTodo(id);
      });
      wrap.prepend(cb);
    }

    // 拖拽把手（悬停左侧显示；非只读时可拖动排序）
    if (!this.readOnly) {
      const handle = document.createElement("div");
      handle.className = "block-drag-handle";
      handle.textContent = "⠿";
      handle.title = "拖动排序";
      handle.draggable = true;
      handle.addEventListener("dragstart", (e) => {
        this.draggingId = id;
        e.dataTransfer?.setData("text/plain", id);
        e.dataTransfer && (e.dataTransfer.effectAllowed = "move");
      });
      handle.addEventListener("dragend", () => {
        this.draggingId = null;
        this.clearDropIndicator();
      });
      wrap.appendChild(handle);
    }

    const idChip = document.createElement("span");
    idChip.className = "block-id";
    idChip.textContent = `#${id.slice(0, 4)}`;
    // 块 ID 是操作锚定/光标定位/远程渲染的地址：悬停看全 ID，点击复制
    idChip.title = `块 ID：${id}（点击复制）`;
    idChip.style.cursor = "pointer";
    idChip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      void navigator.clipboard?.writeText(id).then(
        () => this.hooks.onToast?.(`已复制块 ID：${id.slice(0, 8)}…`, "info"),
        () => this.hooks.onToast?.("复制失败", "warn"),
      );
    });
    wrap.appendChild(idChip);
    return wrap;
  }

  /** 同步单个块的文本/勾选态到 DOM（不动结构） */
  private syncBlockDom(blockId: string) {
    const wrap = this.nodes.get(blockId);
    const block = this.model.block(blockId);
    if (!wrap || !block) return;
    wrap.classList.toggle("checked", !!block.checked);
    const cb = wrap.querySelector<HTMLElement>(".block-checkbox");
    if (cb) cb.classList.toggle("on", !!block.checked);
    this.reconcileBlock(blockId);
  }

  /** 块内 .block-text 节点（搜索/高亮等外部模块用） */
  textNodeOf(id: string): HTMLElement | undefined {
    return this.nodes.get(id)?.querySelector<HTMLElement>(".block-text") ?? undefined;
  }

  reconcileBlock(blockId: string) {
    if (blockId === this.composingBlockId) {
      return; // IME 组词中不重写 DOM，compositionend 后统一 diff
    }
    const el = this.textNodeOf(blockId);
    if (!el) return;
    const modelText = this.model.visibleText(blockId);
    const domText = el.textContent ?? "";
    el.dataset.empty = modelText ? "" : "true";
    if (domText === modelText) return;
    const focused = document.activeElement === el;
    const caret = focused ? getCaretOffset(el) : null;
    el.textContent = modelText;
    if (focused && caret !== null) {
      setCaretOffset(el, caretShift(domText, modelText, caret));
    }
  }

  renderLocks() {
    if (!this.lockInfoProvider) return;
    for (const [id, wrap] of this.nodes) {
      const textEl = wrap.querySelector<HTMLElement>(".block-text");
      if (!textEl) continue;
      let chip = wrap.querySelector<HTMLElement>(".lock-chip");
      if (this.readOnly) {
        wrap.classList.remove("locked");
        chip?.remove();
        textEl.contentEditable = "false";
        continue;
      }
      const info = this.lockInfoProvider(id);
      if (info?.holder) {
        wrap.classList.add("locked");
        wrap.style.setProperty("--lock-color", info.holder.color);
        if (!chip) {
          chip = document.createElement("span");
          chip.className = "lock-chip";
          wrap.appendChild(chip);
        }
        chip.textContent = `🔒 ${info.holder.name} 编辑中`;
        if (info.enforced) textEl.contentEditable = "false";
        else textEl.contentEditable = "plaintext-only";
      } else {
        wrap.classList.remove("locked");
        chip?.remove();
        textEl.contentEditable = "plaintext-only";
      }
    }
  }

  // ------------------------------------------------------------- 事件绑定

  private bindEvents() {
    this.el.addEventListener("input", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
      if (!target?.dataset.id) return;
      this.handleInput(target.dataset.id, (e as InputEvent).isComposing);
    });
    this.el.addEventListener("compositionstart", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
      this.composingBlockId = target?.dataset.id ?? null;
    });
    this.el.addEventListener("compositionend", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
      this.composingBlockId = null;
      if (target?.dataset.id) this.handleInput(target.dataset.id, false);
    });
    this.el.addEventListener("keydown", (e) => this.onKeydown(e));
    this.el.addEventListener("paste", (e) => this.onPaste(e));
    this.el.addEventListener("dragover", (e) => e.preventDefault());
    this.el.addEventListener("drop", (e) => e.preventDefault()); // 拖放不接入模型，避免富文本 DOM

    // 拖拽排序：dragover 计算落点（前/后），drop 提交 block.move
    this.el.addEventListener("dragover", (e) => {
      if (!this.draggingId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block");
      this.updateDropIndicator(target, e.clientY);
    });
    this.el.addEventListener("drop", (e) => {
      if (!this.draggingId) return;
      e.preventDefault();
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block");
      const plan = this.dropPlan(target, e.clientY);
      this.clearDropIndicator();
      const id = this.draggingId;
      this.draggingId = null;
      if (!id || !plan) return;
      if (plan.beforeId === id) return; // 拖到自己前 = 原位
      if ((plan.beforeId ?? null) === (this.nextIdOf(id) ?? null)) return; // 没动
      this.queue.submitImmediate(
        [{ type: "block.move", id, beforeId: plan.beforeId, undoBeforeId: this.nextIdOf(id) ?? null }],
        { selBefore: null },
      );
    });
    this.el.addEventListener("dragleave", (e) => {
      if (!this.draggingId) return;
      if (e.target === this.el) this.clearDropIndicator();
    });

    this.el.addEventListener("focusin", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
      if (target?.dataset.id) this.hooks.onFocusBlock(target.dataset.id);
    });
    this.el.addEventListener("focusout", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
      if (!target?.dataset.id) return;
      const to = e.relatedTarget as HTMLElement | null;
      const toBlock = to?.closest<HTMLElement>(".block-text");
      if (toBlock && toBlock.dataset.id === target.dataset.id) return; // 块内焦点移动
      // 跨块移动或离开编辑器：释放旧块（新块的 focusin 会自行申请）
      this.hooks.onBlurBlock(target.dataset.id);
    });
  }

  // ------------------------------------------------------------- 文本输入

  private handleInput(blockId: string, isComposing: boolean) {
    if (this.readOnly) return;
    const el = this.textNodeOf(blockId);
    if (!el) return;
    const newText = el.textContent ?? "";
    const oldText = this.model.visibleText(blockId);
    if (newText === oldText) {
      this.updateSlashMenu(blockId, newText);
      return;
    }
    const { ops } = diffText(oldText, newText);
    if (ops.length === 0) return;
    for (const op of ops) {
      if (op.type === "text.insert" || op.type === "text.delete") op.blockId = blockId;
    }
    const selBefore: SelectionPoint = { blockId, offset: getCaretOffset(el) ?? oldText.length };
    const txId = this.queue.scheduleBatch(selBefore);
    this.queue.markDirty();
    this.model.applyLocal(txId, ops);
    this.hooks.onCursor(blockId, getCaretOffset(el) ?? 0);
    if (!isComposing) this.checkMarkdownTrigger(blockId, newText);
    this.updateSlashMenu(blockId, newText);
  }

  /**
   * Markdown 快捷输入：块内容恰为触发串（如 "# "、"[ ] "、"```"）时，
   * 删除触发串并把块转换为对应类型 —— 与 / 菜单同一套事务管线（可撤销/同步/冲突处理）。
   */
  private checkMarkdownTrigger(blockId: string, text: string) {
    if (text === "/" || text.startsWith("/")) return; // "/" 交给菜单处理
    for (const { re, type, checked } of MARKDOWN_TRIGGERS) {
      if (!re.test(text)) continue;
      const cur = this.model.block(blockId);
      if (!cur) return;
      const ops: Op[] = [
        { type: "text.delete", blockId, offset: 0, length: text.length, text },
      ];
      const typeChanged = cur.type !== type;
      const checkChanged = type === "todo" && checked !== undefined && !!cur.checked !== checked;
      if (typeChanged || checkChanged) {
        ops.push({
          type: "block.update",
          id: blockId,
          ...(typeChanged ? { blockType: type, prevBlockType: cur.type } : {}),
          ...(checked !== undefined ? { checked, prevChecked: cur.checked } : {}),
        });
      }
      this.queue.submitImmediate(ops, {
        selBefore: { blockId, offset: 0 },
        caretAfter: { blockId, offset: 0 },
      });
      this.focusBlock(blockId, 0);
      return;
    }
  }

  // ------------------------------------------------------------- "/" 菜单

  private openSlashMenu(blockId: string) {
    this.closeSlashMenu();
    const el = document.createElement("div");
    el.className = "slash-menu";
    this.container.appendChild(el);
    this.slash = { blockId, el, active: 0 };
    this.renderSlashMenu("");
    this.positionSlashMenu(blockId);
  }

  private slashItemsFor(filter: string): SlashItem[] {
    const f = filter.trim().toLowerCase();
    if (!f) return SLASH_ITEMS;
    return SLASH_ITEMS.filter(
      (it) =>
        it.label.toLowerCase().includes(f) ||
        it.type.includes(f) ||
        it.hint.includes(f) ||
        it.keys.some((k) => k.includes(f)),
    );
  }

  private renderSlashMenu(filter: string) {
    if (!this.slash) return;
    const items = this.slashItemsFor(filter);
    this.slash.el.innerHTML = "";
    this.slash.active = Math.min(this.slash.active, Math.max(0, items.length - 1));
    items.forEach((it, i) => {
      const item = document.createElement("div");
      item.className = "slash-item" + (i === this.slash!.active ? " active" : "");
      const name = document.createElement("span");
      name.textContent = it.label;
      const hint = document.createElement("em");
      hint.textContent = it.hint;
      item.appendChild(name);
      item.appendChild(hint);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // 不抢编辑焦点
        this.applySlash(it.type);
      });
      this.slash!.el.appendChild(item);
    });
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-empty";
      empty.textContent = "没有匹配的块类型";
      this.slash.el.appendChild(empty);
    }
  }

  private positionSlashMenu(blockId: string) {
    if (!this.slash) return;
    const rect = this.blockRectAt(blockId, 1);
    if (!rect) return;
    const host = this.container.getBoundingClientRect();
    // 菜单实际高度（渲染后测量；首次渲染前用估值）
    const menuH = this.slash.el.offsetHeight || 300;
    const menuW = 240;
    const left = Math.max(0, Math.min(rect.left - host.left, host.width - menuW - 8));
    this.slash.el.style.left = `${left}px`;
    // 防遮挡：下方放不下时翻转到行上方
    const overflowBelow = rect.bottom + menuH + 12 > window.innerHeight;
    const top = overflowBelow ? rect.top - host.top - menuH - 4 : rect.bottom - host.top + 4;
    this.slash.el.style.top = `${Math.max(0, top)}px`;
  }

  /** 输入变化时驱动菜单开合与过滤 */
  private updateSlashMenu(blockId: string, text: string) {
    if (text.startsWith("/")) {
      if (!this.slash || this.slash.blockId !== blockId) {
        this.openSlashMenu(blockId);
      } else {
        this.positionSlashMenu(blockId);
      }
      this.renderSlashMenu(text.slice(1));
    } else if (this.slash) {
      this.closeSlashMenu();
    }
  }

  closeSlashMenu() {
    this.slash?.el.remove();
    this.slash = null;
  }

  private applySlash(type: BlockType) {
    if (!this.slash) return;
    const { blockId } = this.slash;
    const cur = this.model.block(blockId);
    const el = this.textNodeOf(blockId);
    if (!cur || !el) {
      this.closeSlashMenu();
      return;
    }
    const slashText = el.textContent ?? "";
    const ops: Op[] = [];
    // 删掉 "/过滤词"
    if (slashText.length > 0) {
      ops.push({ type: "text.delete", blockId, offset: 0, length: slashText.length, text: slashText });
    }
    if (type !== cur.type) {
      ops.push({ type: "block.update", id: blockId, blockType: type, prevBlockType: cur.type });
    }
    this.closeSlashMenu();
    if (ops.length > 0) {
      this.queue.submitImmediate(ops, {
        selBefore: { blockId, offset: 0 },
        caretAfter: { blockId, offset: 0 },
      });
    }
    this.focusBlock(blockId, 0);
  }

  private slashKeydown(e: KeyboardEvent): boolean {
    if (!this.slash) return false;
    const items = this.slash.el.querySelectorAll(".slash-item");
    if (e.key === "Escape") {
      e.preventDefault();
      this.closeSlashMenu();
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      if (n > 0) {
        this.slash.active = (this.slash.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        this.renderSlashMenu((this.textNodeOf(this.slash.blockId)?.textContent ?? "/").slice(1));
      }
      return true;
    }
    if (e.key === "Enter" && items.length > 0) {
      e.preventDefault();
      const items2 = this.slashItemsFor((this.textNodeOf(this.slash.blockId)?.textContent ?? "/").slice(1));
      const picked = items2[this.slash.active];
      if (picked) this.applySlash(picked.type);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- 键盘手势

  private onKeydown(e: KeyboardEvent) {
    if (this.slashKeydown(e)) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
    if (!target?.dataset.id) return;
    if (this.readOnly) {
      // 只读模式仅放行复制/滚动类按键
      if (!(e.ctrlKey || e.metaKey) || !["c", "a"].includes(e.key.toLowerCase())) e.preventDefault();
      return;
    }
    const id = target.dataset.id;
    const block = this.model.block(id);
    const bType = block?.type ?? "text";
    const text = this.model.visibleText(id);
    const offset = getCaretOffset(target) ?? 0;
    const idx = this.model.blockIndex(id);
    const prev = idx > 0 ? this.model.blocks[idx - 1] : null;
    const next = idx >= 0 && idx < this.model.blocks.length - 1 ? this.model.blocks[idx + 1] : null;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && ["b", "i", "u"].includes(e.key.toLowerCase())) {
      e.preventDefault(); // 纯文本编辑器，禁用富文本快捷键
      return;
    }
    if (mod) return; // Ctrl+Z/Y 撤销重做在页面级处理（避免焦点丢失后失效）
    if (e.key === "Enter") {
      e.preventDefault();
      // 空的列表/待办块回车 → 转为正文（退出列表）
      if ((bType === "bullet" || bType === "todo") && text === "") {
        this.queue.submitImmediate(
          [{ type: "block.update", id, blockType: "text", prevBlockType: bType, ...(block?.checked !== undefined ? { checked: false, prevChecked: block.checked } : {}) }],
          { selBefore: { blockId: id, offset: 0 }, caretAfter: { blockId: id, offset: 0 } },
        );
        this.focusBlock(id, 0);
        return;
      }
      // 列表/待办：回车续型；其余：新块为正文
      const newType: BlockType = bType === "bullet" || bType === "todo" ? bType : "text";
      this.splitAt(id, offset, newType);
      return;
    }
    if (e.key === "Backspace" && offset === 0 && this.selectionCollapsed()) {
      // 非正文块在块首退格 → 转为正文（而不是合并）
      if (bType !== "text") {
        e.preventDefault();
        this.queue.submitImmediate(
          [{ type: "block.update", id, blockType: "text", prevBlockType: bType, ...(block?.checked !== undefined ? { checked: false, prevChecked: block.checked } : {}) }],
          { selBefore: { blockId: id, offset: 0 }, caretAfter: { blockId: id, offset: 0 } },
        );
        this.focusBlock(id, 0);
        return;
      }
      if (prev) {
        e.preventDefault();
        this.mergeIntoPrev(id);
      } else if (this.model.blocks.length > 1 && text === "") {
        e.preventDefault();
        this.deleteBlock(id);
      }
      return; // 第一个块的光标前退格：无操作
    }
    if (e.key === "Delete" && offset === text.length && this.selectionCollapsed() && next) {
      e.preventDefault();
      this.mergeNextInto(id);
      return;
    }
    if (e.key === "ArrowLeft" && offset === 0 && prev) {
      e.preventDefault();
      this.focusBlock(prev.id, this.model.visibleText(prev.id).length);
      return;
    }
    if (e.key === "ArrowRight" && offset === text.length && next) {
      e.preventDefault();
      this.focusBlock(next.id, 0);
      return;
    }
    if (e.key === "ArrowUp" && offset === 0 && prev) {
      e.preventDefault();
      this.focusBlock(prev.id, this.model.visibleText(prev.id).length);
      return;
    }
    if (e.key === "ArrowDown" && offset === text.length && next) {
      e.preventDefault();
      this.focusBlock(next.id, 0);
      return;
    }
  }

  /** 图片 → 压缩（长边 ≤1280，迭代降质到上限内）→ image 块事务 */
  private async insertImageBlock(file: File) {
    const dataUrl = await compressImage(file, 300_000).catch(() => null);
    if (!dataUrl) {
      this.hooks.onToast?.("图片处理失败或过大", "warn");
      return;
    }
    const sel = this.currentSelection();
    const anchorId = sel?.blockId ?? this.model.blocks[this.model.blocks.length - 1]?.id;
    if (!anchorId) return;
    const newId = uuid();
    this.queue.submitImmediate(
      [{ type: "block.insert", id: newId, afterId: anchorId, text: "", blockType: "image", src: dataUrl }],
      { selBefore: sel, caretAfter: { blockId: newId, offset: 0 } },
    );
  }

  private selectionCollapsed(): boolean {
    const sel = getSelection();
    return !sel || sel.isCollapsed;
  }

  private toggleTodo(id: string) {
    if (this.readOnly) return;
    const block = this.model.block(id);
    if (!block) return;
    const cur = !!block.checked;
    this.queue.submitImmediate(
      [{ type: "block.update", id, checked: !cur, prevChecked: cur }],
      { selBefore: null },
    );
  }

  // ------------------------------------------------------------- 结构手势

  private splitAt(id: string, offset: number, newType: BlockType) {
    const text = this.model.visibleText(id);
    const head = text.slice(0, offset);
    const tail = text.slice(offset);
    const newId = uuid();
    const ops: Op[] = [];
    if (tail.length > 0) {
      ops.push({ type: "text.delete", blockId: id, offset, length: tail.length, text: tail });
    }
    ops.push({
      type: "block.insert",
      id: newId,
      afterId: id,
      text: tail,
      blockType: newType,
      ...(newType === "todo" ? { checked: false } : {}),
    });
    this.queue.submitImmediate(ops, {
      selBefore: { blockId: id, offset: head.length },
      caretAfter: { blockId: newId, offset: 0 },
    });
    this.focusBlock(newId, 0);
  }

  private mergeIntoPrev(id: string) {
    const idx = this.model.blockIndex(id);
    if (idx <= 0) return;
    const prev = this.model.blocks[idx - 1];
    const curBlock = this.model.block(id)!;
    const curText = this.model.visibleText(id);
    const prevLen = this.model.visibleText(prev.id).length;
    const ops: Op[] = [];
    if (curText.length > 0) {
      ops.push({ type: "text.insert", blockId: prev.id, offset: prevLen, text: curText });
    }
    ops.push({
      type: "block.delete",
      id,
      text: curText,
      prevId: prev.id,
      blockType: curBlock.type,
      ...(curBlock.checked !== undefined ? { checked: curBlock.checked } : {}),
    });
    this.queue.submitImmediate(ops, {
      selBefore: { blockId: id, offset: 0 },
      caretAfter: { blockId: prev.id, offset: prevLen },
    });
    this.focusBlock(prev.id, prevLen);
  }

  private mergeNextInto(id: string) {
    const idx = this.model.blockIndex(id);
    const next = this.model.blocks[idx + 1];
    if (!next) return;
    const nextBlock = this.model.block(next.id)!;
    const nextText = this.model.visibleText(next.id);
    const curLen = this.model.visibleText(id).length;
    const ops: Op[] = [];
    if (nextText.length > 0) {
      ops.push({ type: "text.insert", blockId: id, offset: curLen, text: nextText });
    }
    ops.push({
      type: "block.delete",
      id: next.id,
      text: nextText,
      prevId: id,
      blockType: nextBlock.type,
      ...(nextBlock.checked !== undefined ? { checked: nextBlock.checked } : {}),
    });
    this.queue.submitImmediate(ops, {
      selBefore: { blockId: id, offset: curLen },
      caretAfter: { blockId: id, offset: curLen },
    });
    this.focusBlock(id, curLen);
  }

  private deleteBlock(id: string) {
    const idx = this.model.blockIndex(id);
    if (this.model.blocks.length <= 1) return; // 至少保留一个块
    const curBlock = this.model.block(id)!;
    const next = this.model.blocks[idx + 1] ?? this.model.blocks[idx - 1];
    this.queue.submitImmediate(
      [
        {
          type: "block.delete",
          id,
          text: this.model.visibleText(id),
          prevId: null,
          blockType: curBlock.type,
          ...(curBlock.checked !== undefined ? { checked: curBlock.checked } : {}),
        },
      ],
      {
        selBefore: { blockId: id, offset: 0 },
        caretAfter: next ? { blockId: next.id, offset: 0 } : null,
      },
    );
    if (next) this.focusBlock(next.id, 0);
  }

  private onPaste(e: ClipboardEvent) {
    if (this.readOnly) return;
    // 图片粘贴 → 压缩为 data URL 建 image 块
    const items = e.clipboardData?.items;
    if (items) {
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            void this.insertImageBlock(file);
            return;
          }
        }
      }
    }
    const target = (e.target as HTMLElement).closest<HTMLElement>(".block-text");
    if (!target?.dataset.id) return;
    e.preventDefault();
    const id = target.dataset.id;
    const caret = getCaretOffset(target);
    if (caret === null) return;
    const raw = e.clipboardData?.getData("text/plain");
    if (!raw) return;
    const lines = raw.replace(/\r\n?/g, "\n").split("\n");
    const curText = this.model.visibleText(id);
    const tail = curText.slice(caret);
    const ops: Op[] = [];
    ops.push({ type: "text.insert", blockId: id, offset: caret, text: lines[0] });
    let anchor = id;
    let lastId = id;
    let lastLen = curText.slice(0, caret).length + lines[0].length;
    for (let i = 1; i < lines.length; i++) {
      const nid = uuid();
      ops.push({ type: "block.insert", id: nid, afterId: anchor, text: lines[i] });
      anchor = nid;
      lastId = nid;
      lastLen = lines[i].length;
    }
    // 多行粘贴时，原光标后的尾巴接到最后一块末尾
    if (lines.length > 1 && tail.length > 0) {
      ops.push({ type: "text.insert", blockId: lastId, offset: lastLen, text: tail });
      lastLen += tail.length;
    }
    this.queue.submitImmediate(ops, {
      selBefore: { blockId: id, offset: caret },
      caretAfter: { blockId: lastId, offset: lastLen },
    });
    this.focusBlock(lastId, lastLen);
  }

  // ------------------------------------------------------------- 撤销/重做

  canUndo(): boolean {
    return !this.readOnly && this.undoMgr.canUndo();
  }

  canRedo(): boolean {
    return !this.readOnly && this.undoMgr.canRedo();
  }

  undo() {
    if (this.readOnly) return;
    const entry = this.undoMgr.popUndo();
    if (!entry) return;
    this.queue.submitImmediate(entry.inverse, {
      recordUndo: false,
      undoFlag: true,
      selBefore: this.currentSelection(),
      caretAfter: entry.selBefore,
    });
    if (entry.selBefore) this.focusBlock(entry.selBefore.blockId, entry.selBefore.offset);
  }

  redo() {
    if (this.readOnly) return;
    const entry = this.undoMgr.popRedo();
    if (!entry) return;
    this.queue.submitImmediate(entry.ops, {
      recordUndo: false,
      selBefore: this.currentSelection(),
      caretAfter: entry.selBefore,
    });
    if (entry.selBefore) this.focusBlock(entry.selBefore.blockId, entry.selBefore.offset);
  }

  // ------------------------------------------------------------- 对外工具

  focusBlock(blockId: string, offset: number) {
    const el = this.textNodeOf(blockId);
    if (!el) return;
    el.focus();
    setCaretOffset(el, offset);
    this.hooks.onCursor(blockId, offset);
  }

  currentSelection(): SelectionPoint | null {
    const el = document.activeElement as HTMLElement | null;
    if (!el?.classList?.contains("block-text")) return null;
    const id = el.dataset.id;
    if (!id) return null;
    const offset = getCaretOffset(el);
    return offset === null ? null : { blockId: id, offset };
  }

  /** 远程光标/菜单定位辅助 */
  blockRectAt(blockId: string, offset: number): DOMRect | null {
    const el = this.textNodeOf(blockId);
    if (!el) return null;
    return rectAtOffset(el, offset);
  }

  /** 远程选区高亮：块内 [start,end) 的逐行矩形（用于叠加层渲染；end 越界收敛到块尾） */
  rectsForRange(blockId: string, start: number, end: number): DOMRect[] {
    const el = this.textNodeOf(blockId);
    if (!el || end <= start) return [];
    const range = document.createRange();
    const a = locate(el, start);
    const b = locate(el, end);
    if (a.node && b.node) {
      range.setStart(a.node, a.local);
      range.setEnd(b.node, b.local);
    } else {
      range.selectNodeContents(el);
    }
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
    if (rects.length === 0) {
      const r = rectAtOffset(el, start);
      return r ? [r] : [];
    }
    return rects;
  }

  /** 两个块之间的文档顺序信息（跨块远程选区用）；任一块不存在返回 null */
  blocksBetween(a: string, b: string): { startId: string; endId: string; middles: string[] } | null {
    const ia = this.model.blockIndex(a);
    const ib = this.model.blockIndex(b);
    if (ia < 0 || ib < 0) return null;
    if (ia === ib) return { startId: a, endId: b, middles: [] };
    // startId 恒为锚点块、endId 恒为终点块（渲染按各自矩形独立进行，与文档顺序无关）；
    // middles 取两者之间的块（按文档顺序）
    const middles: string[] = [];
    for (let i = Math.min(ia, ib) + 1; i < Math.max(ia, ib); i++) middles.push(this.model.blocks[i].id);
    return { startId: a, endId: b, middles };
  }

  /** 当前选区信息（同块返回 anchor/focus；跨块返回两端各自的块与偏移），用于上报 */
  currentSelectionInfo(): { blockId: string; offset: number; focusOffset?: number; focusBlockId?: string } | null {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const anchorEl = (range.startContainer as Node).parentElement?.closest<HTMLElement>(".block-text") ?? null;
    const focusEl = sel.focusNode ? (sel.focusNode.parentElement?.closest<HTMLElement>(".block-text") ?? null) : null;
    if (anchorEl?.dataset.id) {
      const offAt = (el: HTMLElement, container: Node, inner: number) => {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(container, inner);
        return pre.toString().length;
      };
      const anchor = offAt(anchorEl, range.startContainer, range.startOffset);
      if (focusEl && focusEl !== anchorEl && focusEl.dataset.id) {
        const focus = offAt(focusEl, sel.focusNode!, sel.focusOffset);
        return { blockId: anchorEl.dataset.id, offset: anchor, focusOffset: focus, focusBlockId: focusEl.dataset.id };
      }
      if (!focusEl || focusEl === anchorEl) {
        const focusNode = sel.focusNode ?? range.endContainer;
        const focus = focusEl ? offAt(focusEl, focusNode, sel.focusOffset) : anchor;
        if (anchor === focus) return { blockId: anchorEl.dataset.id, offset: anchor };
        return { blockId: anchorEl.dataset.id, offset: Math.min(anchor, focus), focusOffset: Math.max(anchor, focus) };
      }
    }
    // 锚点不在块内（如刚移出编辑器）：退化为 focus 块折叠点
    if (focusEl?.dataset.id) {
      const off = getCaretOffset(focusEl);
      return off === null ? null : { blockId: focusEl.dataset.id, offset: off };
    }
    return null;
  }
}

/** 图片压缩：长边 ≤1280，迭代降质直到 data URL 落入预算；返回 data URL 或 null */
async function compressImage(file: File, budgetChars: number): Promise<string | null> {
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("bad image"));
      el.src = bitmapUrl;
    });
    const MAX_SIDE = 1280;
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    // PNG（截图/透明图）直接尝试；JPEG 迭代降质
    let out = canvas.toDataURL("image/png");
    if (out.length <= budgetChars) return out;
    for (const q of [0.82, 0.7, 0.55, 0.4, 0.25]) {
      out = canvas.toDataURL("image/jpeg", q);
      if (out.length <= budgetChars) return out;
    }
    return out.length <= budgetChars * 1.1 ? out : null; // 最后一线：略超预算也接受（服务端硬上限 300K）
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}
