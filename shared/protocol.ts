/**
 * 共享协议：客户端与服务端共同遵守的数据结构与消息契约。
 *
 * 核心概念：
 * - Block  : 文档的最小结构/同步/加锁/冲突单元，拥有全局唯一 id。
 * - Op     : 原子操作。全部以 BlockId 锚定（不用数组下标，避免并发结构变更时下标漂移）。
 * - Tx     : 事务。一次用户手势（如"回车拆块"）产生的多个 Op 的原子集合，
 *            乐观更新、ACK、重试、幂等去重都以 Tx 为单位。
 * - version: 文档版本，服务器每次成功提交一个 Tx 后 +1，单调递增。
 */

export const PROTOCOL = 1;
/** 内置示例文档 id（无归属，所有人可见；兼容旧版单文档） */
export const DOC_ID = "doc-1";
/** 内置功能说明文档 id（无归属，所有人可见；服务端强制只读） */
export const HELP_DOC_ID = "doc-help";

/** 每多少个版本落一个快照 */
export const SNAPSHOT_EVERY = 50;

/** 块锁 TTL（毫秒）。持锁者需在 TTL 内续期，否则锁过期自动释放。 */
export const LOCK_TTL_MS = 15_000;
/** 在线用户心跳空闲阈值（毫秒）：空闲超过后服务端先发探活 ping，累计 2 倍无响应才剔除 */
export const PRESENCE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 文档数据结构
// ---------------------------------------------------------------------------

/** 块类型：正文 / 标题 / 无序列表 / 待办 / 代码块 */
export type BlockType = "text" | "h1" | "h2" | "h3" | "bullet" | "todo" | "code" | "image";

export const BLOCK_TYPES: BlockType[] = ["text", "h1", "h2", "h3", "bullet", "todo", "code"];

/** 协议层全部合法类型（含不在菜单中的 image） */
const ALL_BLOCK_TYPES: BlockType[] = [...BLOCK_TYPES, "image"];

export function isBlockType(v: unknown): v is BlockType {
  return typeof v === "string" && (ALL_BLOCK_TYPES as string[]).includes(v);
}

/** 传输中的块（服务器内部还有 blockVersion/lastWriter 簿记，不下发客户端） */
export interface BlockData {
  id: string;
  type: BlockType;
  text: string;
  /** todo 块的勾选状态 */
  checked?: boolean;
  /** image 块的图片数据（data URL） */
  src?: string;
}

export interface DocSnapshot {
  docId: string;
  version: number;
  /** 结构版本：任何 block.insert/delete 使其 +1，用于结构类 CAS */
  structureVersion: number;
  blocks: BlockData[];
}

// ---------------------------------------------------------------------------
// 操作与事务
// ---------------------------------------------------------------------------

export interface BlockInsertOp {
  type: "block.insert";
  /** 新块的 id（客户端生成，保证幂等重发不产生重复块） */
  id: string;
  /** 锚定：插入到该块之后；null 表示插到文档末尾 */
  afterId: string | null;
  text: string;
  /** 新块类型，缺省 "text" */
  blockType?: BlockType;
  /** 新块初始勾选态（todo，undo 重建保真） */
  checked?: boolean;
  /** image 块的图片数据（data URL，服务端校验前缀与上限） */
  src?: string;
}
export interface BlockDeleteOp {
  type: "block.delete";
  id: string;
  /** 以下两个字段是撤销(undo)所需的上下文，服务端忽略 */
  text?: string; // 被删块的文本
  prevId?: string | null; // 被删块的前一个块 id（undo 时用于插回原位）
  blockType?: BlockType; // 被删块类型（undo 上下文）
  checked?: boolean;
  src?: string; // 被删图片数据（undo 上下文）
}
/** 更新块属性（类型/勾选），参与块级 CAS，与文本操作同等地位 */
export interface BlockUpdateOp {
  type: "block.update";
  id: string;
  blockType?: BlockType;
  /** undo 上下文：修改前的类型/勾选（服务端忽略） */
  prevBlockType?: BlockType;
  checked?: boolean;
  prevChecked?: boolean;
}
export interface TextInsertOp {
  type: "text.insert";
  blockId: string;
  offset: number;
  text: string;
}
export interface TextDeleteOp {
  type: "text.delete";
  blockId: string;
  offset: number;
  length: number;
  /** 被删除的文本，undo 反演所需，服务端忽略 */
  text?: string;
}

/** 整文档替换（快照恢复）：以给定块集合原子替换全文，无 CAS（显式动作，后做生效） */
export interface DocReplaceOp {
  type: "doc.replace";
  blocks: BlockData[];
  /** undo 上下文：替换前的块（服务端忽略） */
  prevBlocks?: BlockData[];
}

/** 块移动（拖拽排序）：把块移到 beforeId 指定的块之前；null = 移到文档末尾。
 *  用 beforeId 而非 afterId：才能表达"移到最前"（afterId:null 已被占用为末尾）。 */
export interface BlockMoveOp {
  type: "block.move";
  id: string;
  beforeId: string | null;
  /** undo 上下文：移动前位于其后面的块 id（null=原本在末尾），服务端忽略 */
  undoBeforeId?: string | null;
}

export type Op = BlockInsertOp | BlockDeleteOp | BlockUpdateOp | BlockMoveOp | TextInsertOp | TextDeleteOp | DocReplaceOp;
export type TextOp = TextInsertOp | TextDeleteOp;

export interface Tx {
  /** 客户端生成的全局唯一 id：服务器幂等去重的依据 */
  txId: string;
  docId: string;
  /** 客户端提交时所知的文档版本（服务器据此做块级 CAS） */
  baseVersion: number;
  author: string;
  ts: number;
  ops: Op[];
  /** 标记该 Tx 是撤销/重做产生的（仅用于展示） */
  undo?: boolean;
}

export type NackReason =
  /** 块级 CAS 失败：目标块在 baseVersion 之后被他人修改过 */
  | "CONFLICT"
  /** 块被他人持锁且服务器开启强制锁 */
  | "LOCKED"
  /** 非法事务（如 baseVersion 超前于服务器） */
  | "INVALID";

// ---------------------------------------------------------------------------
// 在线用户 / 锁 / 配置
// ---------------------------------------------------------------------------

export interface UserInfo {
  userId: string;
  name: string;
  color: string;
  /** 是否访客（服务器在 init.you 中携带；presence 列表中可选） */
  isGuest?: boolean;
}

export interface LockState {
  blockId: string;
  holder: UserInfo;
  expiresAt: number; // epoch ms
}

export interface DocConfig {
  /** 是否强制块锁：true 时他人对持锁块的写入会被服务器拒绝 */
  lockEnforced: boolean;
}

/** 块级评论（docs/01-F） */
export interface CommentData {
  id: number;
  blockId: string;
  userId: string;
  name: string;
  color: string;
  body: string;
  createdAt: number;
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// 消息定义
// ---------------------------------------------------------------------------

export type DocRole = "owner" | "editor" | "viewer";

/** 客户端 → 服务器 */
export type ClientMsg =
  | { t: "hello"; docId: string; token?: string; name?: string; mode?: "view" }
  | { t: "tx"; tx: Tx }
  | { t: "cursor"; blockId: string; offset: number; focusOffset?: number; focusBlockId?: string }
  | { t: "lock.acquire"; blockId: string }
  | { t: "lock.release"; blockId: string }
  | {
      t: "sync";
      haveVersion: number;
      /** 重连对账：告知服务器我还有哪些未确认的 Tx，服务器回告其中已执行的 */
      pendingTxIds: string[];
    }
  | { t: "ping" }
  | { t: "config"; lockEnforced: boolean };

/** 服务器 → 客户端 */
export type ServerMsg =
  | {
      t: "init";
      you: UserInfo;
      /** 会话令牌：客户端保存（sessionStorage），重连/刷新凭它继承身份 */
      token: string;
      doc: DocSnapshot;
      presence: UserInfo[];
      locks: LockState[];
      config: DocConfig;
      /** 本连接在本文档的权限 */
      role: DocRole;
    }
  | { t: "ack"; txId: string; version: number }
  | {
      t: "nack";
      txId: string;
      reason: NackReason;
      version: number;
      /** 冲突块的权威文本（客户端据此修复本地状态） */
      blocks?: { id: string; text: string }[];
    }
  | { t: "remote.op"; tx: Tx; version: number }
  | { t: "presence"; users: UserInfo[] }
  | { t: "cursor"; userId: string; blockId: string; offset: number; focusOffset?: number; focusBlockId?: string }
  | { t: "lock.changed"; blockId: string; lock: LockState | null }
  | { t: "lock.denied"; blockId: string; holder: UserInfo }
  | { t: "config.changed"; config: DocConfig }
  | {
      t: "snapshot";
      doc: DocSnapshot;
      reason: "sync";
      /** pendingTxIds 中已被服务器执行过的（ACK 丢失场景），客户端应视为已提交 */
      ackedTxIds: string[];
    }
  | { t: "comment.added"; docId: string; comment: CommentData }
  | { t: "pong" }
  | { t: "error"; message: string };

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // 兜底（理论不会走到）
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export const USER_COLORS = [
  "#f43f5e", "#3b82f6", "#10b981", "#f59e0b",
  "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
];

/** 对新旧文本做前后缀 diff，推导出一个 insert 或 delete（或 replace 两个 op） */
export function diffText(
  oldText: string,
  newText: string
): { ops: TextOp[]; commonPrefix: number } {
  if (oldText === newText) return { ops: [], commonPrefix: oldText.length };
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < oldText.length - p &&
    s < newText.length - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  )
    s++;
  const removed = oldText.slice(p, oldText.length - s);
  const inserted = newText.slice(p, newText.length - s);
  const ops: TextOp[] = [];
  if (removed.length > 0)
    ops.push({ type: "text.delete", blockId: "", offset: p, length: removed.length, text: removed });
  if (inserted.length > 0)
    ops.push({ type: "text.insert", blockId: "", offset: p, text: inserted });
  return { ops, commonPrefix: p };
}
