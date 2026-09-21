/**
 * UndoManager：客户端撤销/重做栈。
 *
 * - 撤销 = 以"逆操作"提交一个新 Tx（天然同步给其他用户），不是状态回退；
 * - 连续纯插入（打字）在 800ms 内合并为一个撤销单元（词级撤销体验）；
 * - 已知限制（docs/04 有讨论）：线性撤销不感知他人对同一块的修改，
 *   撤销与远端编辑撞块时可能被服务器拒绝或错位，属可接受的取舍。
 */
import type { Op } from "@shared/protocol";
import { invertOps } from "./util";

export interface SelectionPoint {
  blockId: string;
  offset: number;
}

export interface UndoEntry {
  txId: string;
  /** 原操作（重做用） */
  ops: Op[];
  /** 逆操作（撤销用），创建时已物化（含被删文本等上下文） */
  inverse: Op[];
  selBefore: SelectionPoint | null;
  ts: number;
}

const COALESCE_MS = 800;

export class UndoManager {
  private stack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  canUndo(): boolean {
    return this.stack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 记录一个已提交的 Tx（在 flush 时调用，ops 为发送版本） */
  record(txId: string, ops: Op[], selBefore: SelectionPoint | null) {
    if (ops.length === 0) return;
    this.redoStack = []; // 新编辑打断重做链

    const last = this.stack[this.stack.length - 1];
    if (last && this.coalescable(last, ops, txId)) {
      last.ops = [...last.ops, ...ops];
      last.inverse = invertOps(last.ops);
      last.ts = Date.now();
      return;
    }
    this.stack.push({ txId, ops: [...ops], inverse: invertOps(ops), selBefore, ts: Date.now() });
    if (this.stack.length > 200) this.stack.shift();
  }

  /** 连续、同块、纯插入且时间邻近 → 可合并为一个撤销单元 */
  private coalescable(last: UndoEntry, ops: Op[], _txId: string): boolean {
    if (Date.now() - last.ts > COALESCE_MS) return false;
    const lastAllInserts =
      last.ops.every((o) => o.type === "text.insert") && last.ops.length > 0;
    const allInserts = ops.every((o) => o.type === "text.insert");
    if (!lastAllInserts || !allInserts) return false;
    const blockOf = (o: Op) => (o.type === "text.insert" || o.type === "text.delete" ? o.blockId : "");
    return blockOf(last.ops[0]) === blockOf(ops[0]);
  }

  /** 取出一次撤销：返回逆操作与撤销前选区 */
  popUndo(): { inverse: Op[]; selBefore: SelectionPoint | null } | null {
    const e = this.stack.pop();
    if (!e) return null;
    this.redoStack.push(e);
    return { inverse: e.inverse, selBefore: e.selBefore };
  }

  /** 取出一次重做：返回原操作 */
  popRedo(): { ops: Op[]; selBefore: SelectionPoint | null } | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.stack.push(e);
    return { ops: e.ops, selBefore: e.selBefore };
  }

  size(): number {
    return this.stack.length;
  }
}
