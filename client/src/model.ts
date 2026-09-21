/**
 * DocModel：客户端文档模型（同步层的核心）。
 *
 * 状态分层（关键设计）：
 *   可见状态 blocks   = 服务器权威文本 serverText  ⊕  我未确认的本地 ops（按提交顺序折叠）
 *   - 服务器文本只被三类事件推进：remote.op（他人）、ack（自己）、snapshot（重连对账）；
 *   - 本地 ops 记录在 pending 列表里，遇同块远程修改会做"块内微型变换"（util.transformTextOp）；
 *   - ACK 时用"发送时的 ops"推进 serverText，可见文本不变（本地早已乐观显示）；
 *   - NACK/断线重连走同一条修复管线：回滚(或快照重置) → 修正 ops → 重放 → 重发。
 *
 * 收敛性论证见 docs/04：服务器块级 CAS 保证"我的 ack 发生时，serverText 恰好等于
 * 我发送 ops 的应用基底"，因此本地折叠与服务器应用结果逐字符一致。
 */
import type { BlockData, DocSnapshot, Op, Tx } from "@shared/protocol";
import { applyTextOp, invertOp, isTextOp, transformTextOp } from "./util";

export type ModelEvent =
  | { kind: "text"; blockId: string }
  | { kind: "structure" }
  | { kind: "sync" };

export interface PendingTx {
  txId: string;
  ops: Op[];
}

export interface DroppedOp {
  op: Op;
  reason: string;
}

export class DocModel {
  blocks: BlockData[] = [];
  version = 0;
  structureVersion = 0;
  loaded = false;
  /** 服务器权威文本（含我已 ack 的；不含我未确认的乐观修改） */
  serverText = new Map<string, string>();
  /** 未确认的本地事务，按提交顺序 */
  pending: PendingTx[] = [];

  private listeners = new Set<(e: ModelEvent) => void>();

  on(fn: (e: ModelEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ModelEvent) {
    for (const fn of this.listeners) fn(e);
  }

  // ------------------------------------------------------------------ 查询

  block(id: string): BlockData | undefined {
    return this.blocks.find((b) => b.id === id);
  }

  blockIndex(id: string): number {
    return this.blocks.findIndex((b) => b.id === id);
  }

  visibleText(id: string): string {
    return this.block(id)?.text ?? "";
  }

  pendingIds(): string[] {
    return this.pending.map((p) => p.txId);
  }

  pendingFor(txId: string): Op[] {
    return this.pending.find((p) => p.txId === txId)?.ops ?? [];
  }

  hasPendingOn(blockId: string): boolean {
    return this.pending.some((p) => p.ops.some((o) => isTextOp(o) && o.blockId === blockId));
  }

  // ------------------------------------------------------------- 初始加载

  loadSnapshot(doc: DocSnapshot) {
    this.blocks = doc.blocks.map((b) => ({ ...b }));
    this.serverText = new Map(doc.blocks.map((b) => [b.id, b.text]));
    this.version = doc.version;
    this.structureVersion = doc.structureVersion;
    this.pending = [];
    this.loaded = true;
    this.emit({ kind: "structure" });
    this.emit({ kind: "sync" });
  }

  // ------------------------------------------------------------ 本地应用

  private ensurePending(txId: string): PendingTx {
    let p = this.pending.find((x) => x.txId === txId);
    if (!p) {
      p = { txId, ops: [] };
      this.pending.push(p);
    }
    return p;
  }

  forgetPending(txId: string) {
    this.pending = this.pending.filter((p) => p.txId !== txId);
  }

  /** 乐观应用一组本地 ops（编辑器已先改 DOM，这里登记模型状态） */
  applyLocal(txId: string, ops: Op[]) {
    if (ops.length === 0) return;
    const p = this.ensurePending(txId);
    let structural = false;
    let textBlock: string | null = null;
    for (const op of ops) {
      p.ops.push(op);
      if (op.type === "block.insert") {
        this.serverText.set(op.id, "");
        this.applyOpToBlocks(op);
        structural = true;
      } else if (op.type === "block.delete") {
        // serverText 保留（服务器要等 ack 才删；回滚/对账都要用）
        this.applyOpToBlocks(op);
        structural = true;
      } else if (op.type === "block.update" || op.type === "doc.replace" || op.type === "block.move") {
        this.applyOpToBlocks(op);
        structural = true;
      } else {
        this.applyOpToBlocks(op);
        textBlock = op.blockId;
      }
    }
    if (structural) this.emit({ kind: "structure" });
    if (textBlock) this.emit({ kind: "text", blockId: textBlock });
  }

  private applyOpToBlocks(op: Op) {
    if (op.type === "block.insert") {
      const idx = op.afterId ? this.blockIndex(op.afterId) : -2;
      const at = idx === -2 ? this.blocks.length : idx === -1 ? this.blocks.length : idx + 1;
      this.blocks.splice(at, 0, {
        id: op.id,
        type: op.blockType ?? "text",
        text: op.text,
        ...(op.checked !== undefined ? { checked: op.checked } : {}),
        ...(op.src !== undefined ? { src: op.src } : {}),
      });
    } else if (op.type === "block.delete") {
      const i = this.blockIndex(op.id);
      if (i >= 0) this.blocks.splice(i, 1);
    } else if (op.type === "block.update") {
      const b = this.block(op.id);
      if (b) {
        if (op.blockType !== undefined) b.type = op.blockType;
        if (op.checked !== undefined) b.checked = op.checked;
      }
    } else if (op.type === "block.move") {
      const i = this.blockIndex(op.id);
      if (i >= 0) {
        const [b] = this.blocks.splice(i, 1);
        const anchor = op.beforeId ? this.blockIndex(op.beforeId) : -2;
        const at = anchor === -2 || anchor === -1 ? this.blocks.length : anchor;
        this.blocks.splice(at, 0, b);
      }
    } else if (op.type === "doc.replace") {
      // 快照恢复：整块替换可见状态（serverText 由调用点同步维护）
      this.blocks = op.blocks.map((b) => ({ ...b }));
    } else {
      const b = this.block(op.blockId);
      if (b) b.text = applyTextOp(b.text, op);
    }
  }

  /** 可见文本重算：serverText ⊕ 全部 pending 中该块的文本 ops */
  private recomputeVisible(blockId: string) {
    const b = this.block(blockId);
    if (!b) return;
    let t = this.serverText.get(blockId) ?? "";
    for (const p of this.pending) {
      for (const op of p.ops) {
        if (isTextOp(op) && op.blockId === blockId) t = applyTextOp(t, op);
      }
    }
    b.text = t;
  }

  // ------------------------------------------------------------ 服务器事件

  /** 收到他人的 remote.op */
  onRemoteOp(tx: Tx, version: number) {
    const touched = new Set<string>();
    let structural = false;

    for (const op of tx.ops) {
      if (isTextOp(op)) {
        const base = this.serverText.get(op.blockId);
        if (base !== undefined) this.serverText.set(op.blockId, applyTextOp(base, op));
        // 我在该块的未确认 ops 做微型变换
        for (const p of this.pending) {
          for (let i = 0; i < p.ops.length; i++) {
            const o = p.ops[i];
            if (isTextOp(o) && o.blockId === op.blockId) p.ops[i] = transformTextOp(o, op);
          }
        }
        touched.add(op.blockId);
      } else if (op.type === "block.insert") {
        this.serverText.set(op.id, op.text);
        this.applyOpToBlocks(op);
        structural = true;
      } else if (op.type === "block.update") {
        // 属性修改不影响 serverText；走结构事件让编辑器重建该块节点
        this.applyOpToBlocks(op);
        structural = true;
      } else if (op.type === "doc.replace") {
        // 他人恢复快照：serverText 整体重置，我的 pending 重放到新基底上
        this.serverText = new Map(op.blocks.map((b) => [b.id, b.text]));
        this.applyOpToBlocks(op);
        const droppedReplay = this.replayPending();
        void droppedReplay; // 丢弃原因由上层提示（onRemoteOp 后接 sync 事件，此处从简）
        structural = true;
      } else if (op.type === "block.delete") {
        // 重锚定：我 pending 的 block.insert 若锚在被删块上 → 改锚到被删块的前一个
        const idx = this.blockIndex(op.id);
        const prevId = idx > 0 ? this.blocks[idx - 1].id : null;
        for (const p of this.pending) {
          for (const o of p.ops) {
            if (o.type === "block.insert" && o.afterId === op.id) o.afterId = prevId;
          }
        }
        this.serverText.delete(op.id);
        this.applyOpToBlocks(op);
        structural = true;
      }
    }

    for (const blockId of touched) this.recomputeVisible(blockId);
    this.version = version;
    if (structural) {
      this.normalizePendingBlocks();
      this.emit({ kind: "structure" });
    }
    for (const blockId of touched) this.emit({ kind: "text", blockId });
    this.emit({ kind: "sync" });
  }

  /**
   * 结构性远程变更后，把我 pending 插入的块移动到与其（可能已重锚的）
   * afterId 一致的位置——与服务器宽松重锚的语义保持一致，避免两端块序分歧。
   */
  private normalizePendingBlocks() {
    for (const p of this.pending) {
      for (const op of p.ops) {
        if (op.type !== "block.insert") continue;
        const idx = this.blockIndex(op.id);
        if (idx < 0) continue;
        const want = op.afterId ? this.blockIndex(op.afterId) + 1 : this.blocks.length - 1;
        // anchor 缺失（尚未插入或已被删）→ 与服务器一致地退化为末尾
        const anchorMissing = op.afterId ? this.blockIndex(op.afterId) < 0 : false;
        const target = anchorMissing ? this.blocks.length - 1 : want;
        if (idx !== target) {
          const [b] = this.blocks.splice(idx, 1);
          const again = op.afterId && !anchorMissing ? this.blockIndex(op.afterId) : this.blocks.length - 1;
          this.blocks.splice(Math.min(again + 1, this.blocks.length), 0, b);
          if (anchorMissing || !op.afterId) op.afterId = null;
        }
      }
    }
  }

  /** 我的 Tx 被确认 */
  onAck(txId: string, version: number) {
    const idx = this.pending.findIndex((p) => p.txId === txId);
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      // 用发送时的 ops 推进 serverText（此时它们未被后续远程 op 变换过，
      // 因为"同块远程 op 提交在我的 tx 之前 ⇒ 我的 tx 必被 nack"）
      for (const op of p.ops) {
        if (isTextOp(op)) {
          const base = this.serverText.get(op.blockId);
          if (base !== undefined) this.serverText.set(op.blockId, applyTextOp(base, op));
        } else if (op.type === "block.insert") {
          this.serverText.set(op.id, op.text);
        } else if (op.type === "block.delete") {
          this.serverText.delete(op.id);
        } else if (op.type === "doc.replace") {
          this.serverText = new Map(op.blocks.map((b) => [b.id, b.text]));
        }
      }
    }
    this.version = version;
    this.emit({ kind: "sync" });
  }

  // ------------------------------------------------------ 修复管线（NACK/重连）

  /**
   * NACK 修复：把全部 pending 从可见状态反向回滚（ Newest first），
   * 覆盖服务器权威文本，再按修正后的 ops 重放。返回被丢弃的 op（如目标块已消失）。
   */
  rebuild(authoritative?: { id: string; text: string }[], dropFilter?: (op: Op) => string | null): DroppedOp[] {
    this.rollbackVisible();
    if (authoritative) {
      for (const a of authoritative) {
        this.serverText.set(a.id, a.text);
        const b = this.block(a.id);
        if (b) b.text = a.text;
      }
    }
    const dropped = this.replayPending(dropFilter);
    this.emit({ kind: "structure" });
    this.emit({ kind: "sync" });
    return dropped;
  }

  /** 重连对账：以服务器快照为基底重建，重放未被 ack 的 pending（已 ack 的直接丢弃） */
  onSnapshotResync(doc: DocSnapshot, ackedTxIds: string[]): DroppedOp[] {
    const keep = this.pending.filter((p) => !ackedTxIds.includes(p.txId));
    this.blocks = doc.blocks.map((b) => ({ ...b }));
    this.serverText = new Map(doc.blocks.map((b) => [b.id, b.text]));
    this.version = doc.version;
    this.structureVersion = doc.structureVersion;
    this.pending = keep;
    this.loaded = true;
    const dropped = this.replayPending();
    this.emit({ kind: "structure" });
    this.emit({ kind: "sync" });
    return dropped;
  }

  /** 把全部 pending 的效果从可见状态反向回滚（pending 列表本身保留） */
  private rollbackVisible() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const ops = [...this.pending[i].ops].reverse();
      for (const op of ops) {
        if (op.type === "block.insert") {
          this.applyOpToBlocks({ type: "block.delete", id: op.id });
          this.serverText.delete(op.id);
        } else if (op.type === "block.delete") {
          this.applyOpToBlocks(invertOp(op));
          // serverText 在本地删除时被保留，插回后两者一致
        } else if (op.type === "doc.replace") {
          this.applyOpToBlocks(invertOp(op));
          // serverText 同步回滚到替换前（key 集合随之恢复）
          const back = invertOp(op);
          if (back.type === "doc.replace") {
            this.serverText = new Map(back.blocks.map((b) => [b.id, b.text]));
          }
        } else {
          this.applyOpToBlocks(invertOp(op));
        }
      }
    }
    // 回滚后可见文本应恰为服务器文本（对齐兜底）
    for (const b of this.blocks) {
      const s = this.serverText.get(b.id);
      if (s !== undefined) b.text = s;
    }
  }

  /** 按提交顺序把 pending 重放到可见状态，同时修正（clamp/重锚定）ops；返回被丢弃项 */
  private replayPending(dropFilter?: (op: Op) => string | null): DroppedOp[] {
    const dropped: DroppedOp[] = [];
    const alive: PendingTx[] = [];
    for (const p of this.pending) {
      const newOps: Op[] = [];
      for (const op of p.ops) {
        const dropReason = dropFilter?.(op);
        if (dropReason) {
          dropped.push({ op, reason: dropReason });
          continue;
        }
        const adj = this.adjustOp(op);
        if (adj === "skip") continue; // 无可执行内容（如要删的文本已被远程删掉），静默跳过
        if (adj === null) {
          dropped.push({ op, reason: "目标块已不存在（可能被他人删除）" });
          continue;
        }
        newOps.push(adj);
        if (adj.type === "block.insert") this.serverText.set(adj.id, "");
        this.applyOpToBlocks(adj);
      }
      if (newOps.length > 0) {
        p.ops = newOps;
        alive.push(p);
      }
    }
    this.pending = alive;
    return dropped;
  }

  /** 重放前修正 op：文本 clamp 到当前块长；结构 op 重锚定。
   *  返回 Op=可执行；"skip"=无内容可执行（静默）；null=目标缺失（丢弃） */
  private adjustOp(op: Op): Op | "skip" | null {
    if (op.type === "text.insert") {
      const b = this.block(op.blockId);
      if (!b) return null;
      return { ...op, offset: Math.min(op.offset, b.text.length) };
    }
    if (op.type === "text.delete") {
      const b = this.block(op.blockId);
      if (!b) return null;
      const off = Math.min(op.offset, b.text.length);
      const len = Math.min(op.length, b.text.length - off);
      if (len <= 0) return "skip";
      return { ...op, offset: off, length: len };
    }
    if (op.type === "block.insert") {
      if (this.block(op.id)) return "skip"; // 已存在，防御
      if (op.afterId && !this.block(op.afterId)) return { ...op, afterId: null }; // 锚点没了 → 追加末尾
      return op;
    }
    if (op.type === "block.delete") {
      if (!this.block(op.id)) return "skip"; // 已被他人删除，语义上已达成
      return op;
    }
    if (op.type === "block.update") {
      if (!this.block(op.id)) return null; // 目标块已消失
      return op;
    }
    if (op.type === "block.move") {
      if (!this.block(op.id)) return "skip"; // 块已消失，语义上无需移动
      if (op.beforeId && !this.block(op.beforeId)) return { ...op, beforeId: null }; // 锚点没了 → 末尾
      return op;
    }
    if (op.type === "doc.replace") {
      if (!Array.isArray(op.blocks) || op.blocks.length === 0) return "skip";
      return op;
    }
    return null;
  }

  /**
   * 采用本地保存的未确认事务（localStorage 恢复）：入列后统一重放到当前快照状态，
   * 之后由 sync 对账（ackedTxIds）剔除服务器已执行的部分。
   */
  adoptPending(txs: { txId: string; ops: Op[] }[]): DroppedOp[] {
    for (const t of txs) {
      if (typeof t?.txId === "string" && Array.isArray(t.ops) && t.ops.length > 0) {
        this.pending.push({ txId: t.txId, ops: [...t.ops] });
      }
    }
    const dropped = this.replayPending();
    this.emit({ kind: "structure" });
    this.emit({ kind: "sync" });
    return dropped;
  }
}
