/**
 * 纯函数工具：文本操作的应用 / 单边变换（"块内微型变换"）/ 光标平移 / 逆操作。
 *
 * transformTextOp 是本项目的关键取舍之一：它不是完整的 OT，
 * 只处理"把我未确认的 insert/delete 平移过一条并发的远程 insert/delete"，
 * 让同块并发编辑在本地呈现为一次"合并"；严格一致性仍由服务器块级 CAS 仲裁。
 */
import type { Op, TextOp } from "@shared/protocol";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 把一个文本 op 应用到字符串（偏移做防御性 clamp） */
export function applyTextOp(text: string, op: TextOp): string {
  if (op.type === "text.insert") {
    const off = clamp(op.offset, 0, text.length);
    return text.slice(0, off) + op.text + text.slice(off);
  }
  const off = clamp(op.offset, 0, text.length);
  const len = clamp(op.length, 0, text.length - off);
  return text.slice(0, off) + text.slice(off + len);
}

/** 单边变换：把我的 op 平移过并发的远程 op（近似，覆盖 insert/delete 两类） */
export function transformTextOp(op: TextOp, remote: TextOp): TextOp {
  if (remote.type === "text.insert") {
    const rl = remote.text.length;
    if (op.type === "text.insert") {
      return { ...op, offset: op.offset >= remote.offset ? op.offset + rl : op.offset };
    }
    // 我的 delete vs 远程 insert
    let off = op.offset;
    let len = op.length;
    let text = op.text ?? "";
    if (remote.offset <= off) {
      off += rl;
    } else if (remote.offset < off + len) {
      // 插入落在删除区间内：删除区间扩大，被删文本同步扩大
      len += rl;
      const rel = remote.offset - off;
      text = text.slice(0, rel) + remote.text + text.slice(rel);
    }
    return { ...op, offset: off, length: len, text };
  }

  // 我的 op vs 远程 delete
  const rs = remote.offset;
  const re = remote.offset + remote.length;
  if (op.type === "text.insert") {
    let off = op.offset;
    if (off >= re) off -= remote.length;
    else if (off > rs) off = rs; // 插入点位于被删区间 → 移到区间起点
    return { ...op, offset: off };
  }
  // 我的 delete vs 远程 delete：收缩掉重叠部分
  const s = op.offset;
  const e = op.offset + op.length;
  const ns = s <= rs ? s : s >= re ? s - remote.length : rs;
  const ne = e <= rs ? e : e >= re ? e - remote.length : rs;
  return { ...op, offset: ns, length: Math.max(0, ne - ns) };
}

/**
 * 光标平移：文本从 oldText 变为 newText 时，原光标 offset 应移到哪里。
 * 用于远程修改命中我正在编辑的块时保持光标体验。
 */
export function caretShift(oldText: string, newText: string, offset: number): number {
  if (oldText === newText) return offset;
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < oldText.length - p &&
    s < newText.length - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  )
    s++;
  const delLen = oldText.length - p - s;
  const insLen = newText.length - p - s;
  if (offset <= p) return offset;
  if (offset >= p + delLen) return offset - delLen + insLen;
  return p + insLen; // 光标在被替换区间内 → 落到新区间末尾
}

/** 求一个 op 的逆 op（用于撤销与本地回滚；依赖创建时填写的上下文字段） */
export function invertOp(op: Op): Op {
  switch (op.type) {
    case "text.insert":
      return { type: "text.delete", blockId: op.blockId, offset: op.offset, length: op.text.length };
    case "text.delete":
      return { type: "text.insert", blockId: op.blockId, offset: op.offset, text: op.text ?? "" };
    case "block.insert":
      return {
        type: "block.delete",
        id: op.id,
        text: op.text,
        prevId: op.afterId,
        blockType: op.blockType,
        checked: op.checked,
        src: op.src,
      };
    case "block.delete":
      return {
        type: "block.insert",
        id: op.id,
        afterId: op.prevId ?? null,
        text: op.text ?? "",
        blockType: op.blockType,
        checked: op.checked,
        src: op.src,
      };
    case "block.update":
      return {
        type: "block.update",
        id: op.id,
        ...(op.blockType !== undefined
          ? { blockType: op.prevBlockType ?? "text", prevBlockType: op.blockType }
          : {}),
        ...(op.checked !== undefined ? { checked: op.prevChecked ?? false, prevChecked: op.checked } : {}),
      };
    case "block.move":
      return { type: "block.move", id: op.id, beforeId: op.undoBeforeId ?? null, undoBeforeId: op.beforeId };
    case "doc.replace":
      return {
        type: "doc.replace",
        blocks: op.prevBlocks && op.prevBlocks.length > 0 ? op.prevBlocks : op.blocks,
        prevBlocks: op.blocks,
      };
  }
}

/** 逆操作序列：先逆序再逐个取逆 */
export function invertOps(ops: Op[]): Op[] {
  return [...ops].reverse().map(invertOp);
}

export function isTextOp(op: Op): op is TextOp {
  return op.type === "text.insert" || op.type === "text.delete";
}


/** 安全 localStorage（Safari 隐私模式/配额满会抛异常，静默降级为内存 Map） */
const memStore = new Map<string, string>();
export const safeStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return memStore.get(key) ?? null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      memStore.set(key, value);
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      memStore.delete(key);
    }
  },
};
