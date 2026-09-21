/**
 * TxQueue：事务的批量合批、发送、超时重发、ACK/NACK 处理与重发调度。
 *
 * - 打字等高频输入按 30ms 窗口合批为一个 Tx（回车/退格等结构性手势立即提交）；
 * - 发送后 5s 未收到 ACK 且连接仍在 → 原样重发（同一 txId，服务器幂等去重）；
 * - NACK：
 *   - CONFLICT → model.rebuild()（回滚+重放，微小变换后的 ops 自动合并）→ 全部重发；
 *   - LOCKED   → model.rebuild(dropFilter=丢弃对他人持锁块的写入) → 重发其余；
 *   - INVALID  → 触发整包对账（重新 sync）。
 * - 重连后由 main 调 onSnapshotResync → resubmitAll() 补发。
 */
import type { Op, Tx } from "@shared/protocol";
import { uuid } from "@shared/protocol";
import type { DroppedOp, DocModel } from "./model";
import type { Net } from "./net";
import type { UndoManager } from "./undo";

const BATCH_MS = 30;
const ACK_TIMEOUT_MS = 5000;
const MAX_TRIES = 5;

interface SendState {
  tries: number;
  timer: number | null;
}

export interface QueueHooks {
  getAuthor: () => string;
  getDocId: () => string;
  /** LOCKED 重建时：判断 op 是否落在他人持锁的块上（返回丢弃原因；null=保留） */
  lockDropFilter: (op: Op) => string | null;
  onToast: (msg: string, kind?: "info" | "warn" | "error") => void;
  onResync: () => void;
}

export class TxQueue {
  private batchTxId: string | null = null;
  private batchTimer: number | null = null;
  private batchSelBefore: { blockId: string; offset: number } | null = null;
  private batchDirty = false;
  private sends = new Map<string, SendState>();

  constructor(
    private model: DocModel,
    private net: Net,
    private undo: UndoManager,
    private hooks: QueueHooks,
  ) {}

  /** 打开（或复用）当前批次；每次输入都会重置 30ms 合批计时器 */
  scheduleBatch(selBefore?: { blockId: string; offset: number } | null): string {
    if (!this.batchTxId) {
      this.batchTxId = uuid();
      this.batchSelBefore = selBefore ?? null;
    }
    if (this.batchTimer !== null) clearTimeout(this.batchTimer);
    this.batchTimer = window.setTimeout(() => this.flushNow(), BATCH_MS);
    return this.batchTxId;
  }

  markDirty() {
    this.batchDirty = true;
  }

  /**
   * 立即提交：先冲掉未关批次（保持顺序），再把 ops 作为一个 Tx 原子提交。
   * 结构性手势（回车/合块/粘贴）与撤销/重走这里。
   */
  submitImmediate(
    ops: Op[],
    opts: {
      recordUndo?: boolean;
      selBefore?: { blockId: string; offset: number } | null;
      undoFlag?: boolean;
      caretAfter?: { blockId: string; offset: number } | null;
    } = {},
  ) {
    this.flushNow();
    const txId = uuid();
    this.batchTxId = txId;
    this.batchSelBefore = opts.selBefore ?? null;
    this.batchDirty = true;
    this.model.applyLocal(txId, ops);
    this.flushNow({ recordUndo: opts.recordUndo, undoFlag: opts.undoFlag });
  }

  /** 立即结束当前批次并发送（结构性手势 / 撤销 / 定时器到期时调用） */
  flushNow(opts: { recordUndo?: boolean; undoFlag?: boolean } = {}) {
    const txId = this.batchTxId;
    const selBefore = this.batchSelBefore;
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchTxId = null;
    this.batchSelBefore = null;
    if (!txId) return;
    const ops = this.model.pendingFor(txId);
    if (ops.length === 0) {
      this.model.forgetPending(txId);
      this.batchDirty = false;
      return;
    }
    if (opts.recordUndo !== false) {
      this.undo.record(txId, [...ops], selBefore);
    }
    const tx: Tx = {
      txId,
      docId: this.hooks.getDocId(),
      baseVersion: this.model.version,
      author: this.hooks.getAuthor(),
      ts: Date.now(),
      ops: structuredClone(ops),
      undo: opts.undoFlag,
    };
    this.batchDirty = false;
    this.send(tx);
  }

  private send(tx: Tx) {
    if (!this.net.send({ t: "tx", tx })) return; // 未连接：留在 pending，等重连补发
    const st = this.sends.get(tx.txId) ?? { tries: 1, timer: null };
    this.sends.set(tx.txId, st);
    if (st.timer !== null) clearTimeout(st.timer);
    st.timer = window.setTimeout(() => {
      st.timer = null;
      const cur = this.sends.get(tx.txId);
      if (!cur || !this.net.open) return;
      if (cur.tries >= MAX_TRIES) return; // 交给重连流程
      cur.tries += 1;
      this.hooks.onToast(`事务 ${tx.txId.slice(0, 6)}… 确认超时，第 ${cur.tries} 次重发`, "info");
      this.send(tx);
    }, ACK_TIMEOUT_MS);
  }

  /** 未确认事务数（含已发送未 ACK 的与断线滞留在本地的） */
  pendingCount(): number {
    return this.model.pending.length + (this.batchTxId && this.batchDirty ? 1 : 0);
  }

  // -------------------------------------------------------------- 服务器回执

  onAck(txId: string, version: number) {
    const st = this.sends.get(txId);
    if (st?.timer !== null && st?.timer !== undefined) clearTimeout(st.timer);
    this.sends.delete(txId);
    this.model.onAck(txId, version);
  }

  onNack(msg: { txId: string; reason: "CONFLICT" | "LOCKED" | "INVALID"; version: number; blocks?: { id: string; text: string }[] }) {
    const st = this.sends.get(msg.txId);
    if (st?.timer !== null && st?.timer !== undefined) clearTimeout(st.timer);
    this.sends.delete(msg.txId);

    if (msg.reason === "INVALID") {
      this.hooks.onResync();
      return;
    }

    let dropped: DroppedOp[] = [];
    if (msg.reason === "CONFLICT") {
      dropped = this.model.rebuild(msg.blocks, undefined);
      if (dropped.length === 0) {
        this.hooks.onToast("检测到同块并发编辑，已自动合并你的修改并重试", "info");
      }
    } else if (msg.reason === "LOCKED") {
      dropped = this.model.rebuild(undefined, this.hooks.lockDropFilter);
      this.hooks.onToast("部分修改被拒绝：目标块正被其他用户锁定编辑", "warn");
    }

    for (const d of dropped) {
      this.hooks.onToast(`一条修改未能保留：${d.reason}`, "warn");
    }
    this.resubmitAll();
  }

  /** 重连对账后（或冲突重建后）：把全部 pending 以当前版本为基线重发（同 txId 幂等） */
  resubmitAll() {
    for (const p of this.model.pending) {
      const tx: Tx = {
        txId: p.txId,
        docId: this.hooks.getDocId(),
        baseVersion: this.model.version,
        author: this.hooks.getAuthor(),
        ts: Date.now(),
        ops: structuredClone(p.ops),
      };
      this.send(tx);
    }
  }

  /** 连接断开时：清掉发送计时（重连后 resubmitAll 统一补发） */
  onDisconnected() {
    for (const st of this.sends.values()) {
      if (st.timer !== null) clearTimeout(st.timer);
      st.timer = null;
    }
  }
}
