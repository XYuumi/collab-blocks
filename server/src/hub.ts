/**
 * Hub：WebSocket 会话管理 + 在线用户（presence）+ 块锁 + 消息仲裁与广播。
 *
 * v3：多文档（房间模型）—— 每条 WS 连接绑定一个 docId，presence/光标/锁/广播全部
 * 按文档作用域隔离；hello 时依据"链接模式 + 文档归属 + enforceOwnerEdit 开关"判定
 * 本连接角色（owner/editor/viewer），viewer 的一切写操作（tx/锁/配置）被拒绝。
 *
 * 安全边界：token 身份（防冒名）、Origin 校验（防跨站 WS 劫持）、限流与规模上限。
 */
import type { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import {
  LOCK_TTL_MS,
  PRESENCE_TIMEOUT_MS,
  type ClientMsg,
  type DocRole,
  type ServerMsg,
  type UserInfo,
  type Tx,
} from "../../shared/protocol";
import type { DocEngine } from "./engine";
import type { DocManager } from "./docmanager";
import type { Store, UserRecord } from "./store";

interface Session {
  ws: WebSocket;
  user: UserRecord;
  token: string;
  docId: string;
  engine: DocEngine;
  role: DocRole;
  lastSeen: number;
  ready: boolean;
  locks: Set<string>;
  /** 限流窗口 */
  rateWindowStart: number;
  rateCount: number;
}

interface LockEntry {
  holderId: string;
  expiresAt: number;
}

/** 单 Tx 限制（防滥用/误用） */
const MAX_OPS_PER_TX = 200;
const MAX_TEXT_PER_OP = 100_000;
/** doc.replace 限制 */
const MAX_REPLACE_BLOCKS = 2000;
const MAX_REPLACE_CHARS = 400_000;
/** 限流：每窗口内最大消息数 */
const RATE_WINDOW_MS = 2000;
const RATE_MAX_MSGS = 120;

export class Hub {
  private sessions = new Map<WebSocket, Session>();
  private locks = new Map<string, LockEntry>(); // `${docId}:${blockId}` → 锁条目
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private docs: DocManager,
  ) {
    // 锁检查注入各文档引擎（按 docId 作用域查询本 Hub 的锁表）
    docs.lockChecker = (docId, blockId, userId) => {
      const l = this.locks.get(this.lockKey(docId, blockId));
      return !!l && l.holderId !== userId && l.expiresAt > Date.now();
    };
  }

  attach(wss: WebSocketServer) {
    wss.on("connection", (ws, req) => {
      if (!this.originAllowed(req)) {
        ws.close(1008, "origin not allowed");
        return;
      }
      this.onConnection(ws);
    });
    this.sweeper = setInterval(() => this.sweep(), 1000);
  }

  close() {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      const reqHost = req.headers.host ?? "";
      return host === reqHost || host === "localhost:5173" || host === "127.0.0.1:5173";
    } catch {
      return false;
    }
  }

  private docSessions(docId: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.ready && s.docId === docId);
  }

  get onlineCount(): number {
    return [...this.sessions.values()].filter((s) => s.ready).length;
  }

  /** 改名后由 HTTP 路由调用：刷新各会话的用户名并广播 presence */
  refreshUser(userId: string) {
    const user = this.store.getUser(userId);
    for (const s of this.sessions.values()) {
      if (s.user.id === userId && user) s.user = user;
    }
    // 广播该用户所在的所有文档房间
    const docIds = new Set([...this.sessions.values()].filter((s) => s.user.id === userId).map((s) => s.docId));
    for (const docId of docIds) this.broadcastPresence(docId);
  }

  // -----------------------------------------------------------------------

  private onConnection(ws: WebSocket) {
    const session: Session = {
      ws,
      user: { id: "pending", username: "", color: "#999", isGuest: true },
      token: "",
      docId: "",
      engine: null as unknown as DocEngine,
      role: "viewer",
      lastSeen: Date.now(),
      ready: false,
      locks: new Set(),
      rateWindowStart: Date.now(),
      rateCount: 0,
    };
    this.sessions.set(ws, session);

    ws.on("message", (data) => {
      const now = Date.now();
      if (now - session.rateWindowStart > RATE_WINDOW_MS) {
        session.rateWindowStart = now;
        session.rateCount = 0;
      }
      if (++session.rateCount > RATE_MAX_MSGS) {
        ws.close(1008, "rate limit exceeded");
        return;
      }

      session.lastSeen = now;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        this.handle(ws, session, msg);
      } catch (err) {
        console.error("[hub] message handling error:", err);
        this.send(ws, { t: "error", message: "服务器内部错误" });
      }
    });

    ws.on("close", () => this.onClose(ws));
    ws.on("error", () => {
      /* close 会随之触发 */
    });
  }

  private handle(ws: WebSocket, session: Session, msg: ClientMsg) {
    if (msg.t === "ping") {
      this.send(ws, { t: "pong" });
      return;
    }
    if (!session.ready && msg.t !== "hello") return; // 必须先 hello

    switch (msg.t) {
      case "hello": {
        // 1) 文档
        const engine = this.docs.get(msg.docId);
        if (!engine) {
          this.send(ws, { t: "error", message: "文档不存在或已删除" });
          ws.close(1008, "doc not found");
          return;
        }
        // 2) 身份
        let user: UserRecord | null = msg.token ? this.store.resolveToken(msg.token) : null;
        let token = msg.token ?? "";
        if (!user) {
          const guest = this.store.createGuest(msg.name);
          user = guest.user;
          token = guest.token;
        }
        // 3) 角色：只读链接 → viewer；"仅创建者可编辑"开启时非 owner → viewer
        const meta = this.store.getDocMeta(msg.docId);
        let role: DocRole;
        if (msg.mode === "view") {
          role = "viewer";
        } else if (meta?.ownerId && meta.enforceOwnerEdit && meta.ownerId !== user.id) {
          role = "viewer";
        } else if (meta?.ownerId === user.id) {
          role = "owner";
        } else {
          role = "editor";
        }
        session.user = user;
        session.token = token;
        session.docId = msg.docId;
        session.engine = engine;
        session.role = role;
        session.ready = true;
        this.send(ws, {
          t: "init",
          you: this.userInfo(session),
          token,
          doc: engine.snapshot(),
          presence: this.presence(session.docId),
          locks: this.activeLocks(session.docId),
          config: engine.config,
          role,
        });
        this.broadcastPresence(session.docId);
        break;
      }
      case "tx": {
        if (session.role === "viewer") {
          this.send(ws, { t: "error", message: "当前为只读模式，无法编辑" });
          return;
        }
        const invalid = this.validateTx(msg.tx);
        if (invalid) {
          this.send(ws, {
            t: "nack",
            txId: msg.tx?.txId ?? "",
            reason: "INVALID",
            version: session.engine.state.version,
          });
          this.send(ws, { t: "error", message: invalid });
          return;
        }
        // 作者身份以服务器会话为准，不信任客户端字段
        const tx: Tx = { ...msg.tx, author: session.user.id };
        const result = session.engine.submit(tx);
        if (result.ok) {
          this.send(ws, { t: "ack", txId: tx.txId, version: result.version });
          this.broadcastDoc(session.docId, { t: "remote.op", tx, version: result.version }, ws);
        } else {
          this.send(ws, {
            t: "nack",
            txId: tx.txId,
            reason: result.reason,
            version: result.version,
            blocks: result.blocks,
          });
        }
        break;
      }
      case "cursor": {
        if (session.role === "viewer") return; // 只读不上报光标
        this.broadcastDoc(
          session.docId,
          { t: "cursor", userId: session.user.id, blockId: msg.blockId, offset: msg.offset },
          ws,
        );
        break;
      }
      case "lock.acquire": {
        if (session.role === "viewer") {
          this.send(ws, { t: "lock.denied", blockId: msg.blockId, holder: this.userInfo(session) });
          return;
        }
        const key = this.lockKey(session.docId, msg.blockId);
        const now = Date.now();
        const existing = this.locks.get(key);
        if (existing && existing.holderId !== session.user.id && existing.expiresAt > now) {
          const holderSession = this.findSession(session.docId, existing.holderId);
          if (holderSession) {
            this.send(ws, {
              t: "lock.denied",
              blockId: msg.blockId,
              holder: this.userInfo(holderSession),
            });
            break;
          }
        }
        this.locks.set(key, { holderId: session.user.id, expiresAt: now + LOCK_TTL_MS });
        session.locks.add(msg.blockId);
        this.broadcastLock(session.docId, msg.blockId);
        break;
      }
      case "lock.release": {
        const key = this.lockKey(session.docId, msg.blockId);
        const l = this.locks.get(key);
        if (l && l.holderId === session.user.id) {
          this.locks.delete(key);
          session.locks.delete(msg.blockId);
          this.broadcastLock(session.docId, msg.blockId);
        }
        break;
      }
      case "sync": {
        this.send(ws, {
          t: "snapshot",
          doc: session.engine.snapshot(),
          reason: "sync",
          ackedTxIds: session.engine.appliedAmong(msg.pendingTxIds),
        });
        break;
      }
      case "config": {
        if (session.role === "viewer") return;
        session.engine.config.lockEnforced = msg.lockEnforced;
        this.broadcastDoc(session.docId, { t: "config.changed", config: session.engine.config });
        break;
      }
    }
  }

  private validateTx(tx: Tx): string | null {
    if (!tx || !Array.isArray(tx.ops)) return "非法事务";
    if (tx.ops.length > MAX_OPS_PER_TX) return `单个事务最多 ${MAX_OPS_PER_TX} 个操作`;
    for (const op of tx.ops) {
      if (op.type === "text.insert" && op.text.length > MAX_TEXT_PER_OP) return "单次插入文本过长";
      if (op.type === "block.insert" && op.text.length > MAX_TEXT_PER_OP) return "新块文本过长";
      if (op.type === "text.delete" && op.length > MAX_TEXT_PER_OP) return "操作长度超限";
      if (op.type === "doc.replace") {
        if (op.blocks.length > MAX_REPLACE_BLOCKS) return `恢复的文档过大（最多 ${MAX_REPLACE_BLOCKS} 块）`;
        const chars = op.blocks.reduce((n, b) => n + (typeof b.text === "string" ? b.text.length : 0), 0);
        if (chars > MAX_REPLACE_CHARS) return "恢复的文档过大";
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------

  private onClose(ws: WebSocket) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.ready) {
      for (const blockId of session.locks) {
        const key = this.lockKey(session.docId, blockId);
        const l = this.locks.get(key);
        if (l && l.holderId === session.user.id) {
          this.locks.delete(key);
          this.broadcastLock(session.docId, blockId);
        }
      }
      this.broadcastPresence(session.docId);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [key, l] of this.locks) {
      if (l.expiresAt <= now) {
        const [docId, ...rest] = key.split(":");
        const blockId = rest.join(":");
        this.locks.delete(key);
        const holder = this.findSession(docId, l.holderId);
        holder?.locks.delete(blockId);
        this.broadcastLock(docId, blockId);
      }
    }
    for (const [ws, s] of this.sessions) {
      if (now - s.lastSeen > PRESENCE_TIMEOUT_MS) {
        ws.terminate();
      }
    }
  }

  // -----------------------------------------------------------------------

  private lockKey(docId: string, blockId: string): string {
    return `${docId}:${blockId}`;
  }

  private findSession(docId: string, userId: string): Session | undefined {
    return this.docSessions(docId).find((s) => s.user.id === userId);
  }

  private userInfo(s: Session): UserInfo {
    return { userId: s.user.id, name: s.user.username, color: s.user.color, isGuest: s.user.isGuest };
  }

  private presence(docId: string): UserInfo[] {
    return this.docSessions(docId).map((s) => ({
      userId: s.user.id,
      name: s.user.username,
      color: s.user.color,
    }));
  }

  private activeLocks(docId: string) {
    const now = Date.now();
    const out: { blockId: string; holder: UserInfo; expiresAt: number }[] = [];
    for (const s of this.docSessions(docId)) {
      for (const blockId of s.locks) {
        const l = this.locks.get(this.lockKey(docId, blockId));
        if (l && l.expiresAt > now && !out.some((x) => x.blockId === blockId)) {
          out.push({
            blockId,
            holder: this.userInfo(s),
            expiresAt: l.expiresAt,
          });
        }
      }
    }
    return out;
  }

  private broadcastLock(docId: string, blockId: string) {
    const now = Date.now();
    const l = this.locks.get(this.lockKey(docId, blockId));
    if (!l || l.expiresAt <= now) {
      this.broadcastDoc(docId, { t: "lock.changed", blockId, lock: null });
      return;
    }
    const holder = this.findSession(docId, l.holderId);
    this.broadcastDoc(docId, {
      t: "lock.changed",
      blockId,
      lock: {
        blockId,
        holder: holder
          ? this.userInfo(holder)
          : { userId: l.holderId, name: "未知用户", color: "#999" },
        expiresAt: l.expiresAt,
      },
    });
  }

  private broadcastPresence(docId: string) {
    this.broadcastDoc(docId, { t: "presence", users: this.presence(docId) });
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastDoc(docId: string, msg: ServerMsg, except?: WebSocket) {
    const raw = JSON.stringify(msg);
    for (const s of this.docSessions(docId)) {
      const ws = s.ws;
      if (ws !== except && ws.readyState === ws.OPEN) ws.send(raw);
    }
  }
}
