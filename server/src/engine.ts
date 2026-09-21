/**
 * DocEngine：文档状态与提交仲裁（服务器的"正确性骨干"）。
 *
 * 提交一个 Tx 的完整流程：
 *  1. 幂等去重：txId 已执行过 → 直接返回缓存的结果（解决"超时重发执行两次"）。
 *     注意：只有"成功执行"才进缓存；nack 表示"未执行"，重发必须重新评估。
 *  2. baseVersion > 当前版本 → INVALID。
 *  3. 在文档副本上顺序应用 ops，任何一步失败则整体回滚（事务原子性）：
 *     - 锁检查：块被他人持锁且开启强制锁 → LOCKED；
 *     - 块级 CAS：block.blockVersion > tx.baseVersion 且 lastWriter != author
 *       （该块在客户端所知版本之后被"别人"改过）→ CONFLICT，并附权威文本；
 *       同作者豁免：自己连续提交的多个 Tx 不互相冲突（它们本来就是顺序可叠的）。
 *  4. 成功 → version+1，触碰的块 blockVersion=新版本、lastWriter=author，
 *     结构变更再 structureVersion+1，进入幂等缓存，触发 onCommit。
 */
import type {
  BlockData,
  DocSnapshot,
  NackReason,
  Tx,
  DocConfig,
} from "../../shared/protocol";
import { SNAPSHOT_EVERY, isBlockType } from "../../shared/protocol";

export interface SrvBlock extends BlockData {
  /** 该块最后一次被修改时的文档版本，块级 CAS 依据 */
  blockVersion: number;
  /** 最后写入者，用于"同作者连续写豁免" */
  lastWriter: string;
}

export interface DocState {
  docId: string;
  version: number;
  structureVersion: number;
  blocks: SrvBlock[];
}

export type SubmitResult =
  | { ok: true; version: number }
  | {
      ok: false;
      reason: NackReason;
      version: number;
      blocks?: { id: string; text: string }[];
    };

const MAX_APPLIED_CACHE = 5000;

export class DocEngine {
  state: DocState;
  config: DocConfig;
  /** txId → 提交后的版本（幂等缓存，仅缓存成功结果） */
  private applied = new Map<string, number>();

  /** 提交成功回调（广播、持久化） */
  onCommit?: (tx: Tx, version: number) => void;
  /** 快照回调：版本跨越 SNAPSHOT_EVERY 倍数时触发 */
  onSnapshot?: (doc: DocSnapshot) => void;

  constructor(
    state: DocState,
    config: DocConfig,
    lockChecker?: (blockId: string, userId: string) => boolean,
  ) {
    this.state = state;
    this.config = config;
    if (lockChecker) this.isLockedByOther = lockChecker;
  }

  private isLockedByOther: (blockId: string, userId: string) => boolean = () => false;

  /** Hub 注入锁查询（块是否被"他人"持锁，含过期判断） */
  setLockChecker(fn: (blockId: string, userId: string) => boolean) {
    this.isLockedByOther = fn;
  }

  snapshot(): DocSnapshot {
    return {
      docId: this.state.docId,
      version: this.state.version,
      structureVersion: this.state.structureVersion,
      blocks: this.state.blocks.map((b) => ({ id: b.id, type: b.type, text: b.text, checked: b.checked, src: b.src })),
    };
  }

  hasApplied(txId: string): number | undefined {
    return this.applied.get(txId);
  }

  /** 查询一批 txId 中已被执行过的（重连对账用） */
  appliedAmong(txIds: string[]): string[] {
    return txIds.filter((id) => this.applied.has(id));
  }

  submit(tx: Tx): SubmitResult {
    // 1. 幂等去重：执行过 → 原样重放结果
    const done = this.applied.get(tx.txId);
    if (done !== undefined) return { ok: true, version: done };

    // 2. 非法基线
    if (tx.baseVersion > this.state.version) {
      return { ok: false, reason: "INVALID", version: this.state.version };
    }

    const conflicts: { id: string; text: string }[] = [];
    const markConflict = (b: SrvBlock) => {
      if (!conflicts.some((c) => c.id === b.id)) conflicts.push({ id: b.id, text: b.text });
    };

    // 3. 在副本上顺序应用，失败即丢弃副本（原子性）
    const working: SrvBlock[] = structuredClone(this.state.blocks);
    const touched = new Set<string>();
    let structural = false;

    const findBlock = (id: string) => working.find((b) => b.id === id);

    for (const op of tx.ops) {
      switch (op.type) {
        case "block.insert": {
          // id 已存在：视为重复提交的同一条 op，跳过（幂等）
          if (findBlock(op.id)) break;
          const nb: SrvBlock = {
            id: op.id,
            type: isBlockType(op.blockType) ? op.blockType : "text",
            text: op.text,
            ...(op.checked !== undefined ? { checked: op.checked } : {}),
            ...(op.blockType === "image" && typeof op.src === "string" && op.src.startsWith("data:image/") ? { src: op.src } : {}),
            blockVersion: 0, // 提交时统一赋新版本
            lastWriter: tx.author,
          };
          const anchor = op.afterId ? findBlock(op.afterId) : undefined;
          const idx = anchor ? working.indexOf(anchor) + 1 : working.length;
          working.splice(idx, 0, nb);
          touched.add(op.id);
          structural = true;
          break;
        }
        case "doc.replace": {
          // 快照恢复：以给定块集合原子替换全文。显式用户动作，无 CAS（后做生效）。
          // 规模校验由 Hub 完成；这里防御性再查一次非空与 id 唯一。
          if (!Array.isArray(op.blocks) || op.blocks.length === 0) {
            return { ok: false, reason: "INVALID", version: this.state.version };
          }
          const ids = new Set<string>();
          for (const b of op.blocks) {
            if (!b || typeof b.id !== "string" || typeof b.text !== "string" || !isBlockType(b.type)) {
              return { ok: false, reason: "INVALID", version: this.state.version };
            }
            if (ids.has(b.id)) {
              return { ok: false, reason: "INVALID", version: this.state.version };
            }
            ids.add(b.id);
          }
          working.length = 0;
          for (const b of op.blocks) {
            working.push({
              id: b.id,
              type: b.type,
              text: typeof b.text === "string" ? b.text : "",
              ...(b.checked !== undefined ? { checked: !!b.checked } : {}),
              ...(b.src !== undefined && typeof b.src === "string" && b.src.startsWith("data:image/") ? { src: b.src } : {}),
              blockVersion: 0,
              lastWriter: tx.author,
            });
            touched.add(b.id);
          }
          structural = true;
          break;
        }
        case "block.update": {
          const b = findBlock(op.id);
          if (!b) return this.conflict(conflicts); // 块已被他人删除
          if (this.lockReject(op.id, tx.author)) return this.locked(op.id);
          if (b.blockVersion > tx.baseVersion && b.lastWriter !== tx.author) {
            markConflict(b);
            return this.conflict(conflicts);
          }
          if (op.blockType !== undefined && isBlockType(op.blockType)) b.type = op.blockType;
          if (op.checked !== undefined) b.checked = op.checked;
          touched.add(b.id); // 属性修改同样推进块版本（参与 CAS）
          break;
        }
        case "block.delete": {
          const b = findBlock(op.id);
          // 块已不存在：并发下已被他人删除，此 op 退化为 no-op（宽松策略）
          if (!b) break;
          if (this.lockReject(op.id, tx.author))
            return this.locked(op.id);
          if (b.blockVersion > tx.baseVersion && b.lastWriter !== tx.author) {
            markConflict(b);
            return this.conflict(conflicts);
          }
          working.splice(working.indexOf(b), 1);
          structural = true;
          break;
        }
        case "text.insert":
        case "text.delete": {
          const b = findBlock(op.blockId);
          if (!b) {
            // 块已不存在（被他人删除）：无法继续，整体拒绝
            return this.conflict(conflicts);
          }
          if (this.lockReject(op.blockId, tx.author)) return this.locked(op.blockId);
          if (b.blockVersion > tx.baseVersion && b.lastWriter !== tx.author) {
            markConflict(b);
            return this.conflict(conflicts);
          }
          if (op.type === "text.insert") {
            const off = clamp(op.offset, 0, b.text.length);
            b.text = b.text.slice(0, off) + op.text + b.text.slice(off);
          } else {
            const off = clamp(op.offset, 0, b.text.length);
            const len = clamp(op.length, 0, b.text.length - off);
            b.text = b.text.slice(0, off) + b.text.slice(off + len);
          }
          touched.add(b.id);
          break;
        }
      }
    }

    // 4. 提交：版本推进 + 簿记
    const prevVersion = this.state.version;
    const newVersion = prevVersion + 1;
    for (const b of working) {
      if (touched.has(b.id)) {
        b.blockVersion = newVersion;
        b.lastWriter = tx.author;
      }
    }
    this.state.blocks = working;
    this.state.version = newVersion;
    if (structural) this.state.structureVersion = newVersion;

    this.applied.set(tx.txId, newVersion);
    if (this.applied.size > MAX_APPLIED_CACHE) {
      const first = this.applied.keys().next().value;
      if (first !== undefined) this.applied.delete(first);
    }

    this.onCommit?.(tx, newVersion);
    if (Math.floor(newVersion / SNAPSHOT_EVERY) > Math.floor(prevVersion / SNAPSHOT_EVERY)) {
      this.onSnapshot?.(this.snapshot());
    }
    return { ok: true, version: newVersion };
  }

  private lockReject(blockId: string, author: string): boolean {
    return this.config.lockEnforced && this.isLockedByOther(blockId, author);
  }

  private locked(blockId: string): SubmitResult {
    void blockId;
    return { ok: false, reason: "LOCKED", version: this.state.version };
  }

  private conflict(blocks: { id: string; text: string }[]): SubmitResult {
    return { ok: false, reason: "CONFLICT", version: this.state.version, blocks };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
