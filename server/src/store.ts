/**
 * Store：SQLite 持久化 + 用户认证（node:sqlite，零原生依赖）。
 *
 * 为什么用 SQLite（而不是继续 JSON 文件）：
 * - 每次提交在同一个事务里落盘 → 消除"防抖 200ms 窗口"的数据丢失；
 * - 用户/会话需要唯一约束与查询（用户名唯一、token 反查），文件做不了；
 * - node:sqlite 内置于 Node 24，无需安装原生模块。
 *
 * 表结构：users / sessions / docs / snapshots。
 * 首次启动时若存在旧版 data/doc.json 自动迁移。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { BlockData, BlockType, DocSnapshot } from "../../shared/protocol";
import { USER_COLORS } from "../../shared/protocol";
import type { DocState, SrvBlock } from "./engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, "../../data");
const DB_FILE = path.join(DATA_DIR, "collab.db");
const LEGACY_DOC_FILE = path.join(DATA_DIR, "doc.json");

export interface UserRecord {
  id: string;
  username: string;
  color: string;
  isGuest: boolean;
}

export class Store {
  private db: DatabaseSync;
  private migrateLegacy: boolean;

  constructor(dbPath = DB_FILE, opts: { migrateLegacy?: boolean } = {}) {
    this.migrateLegacy = opts.migrateLegacy ?? true;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        salt TEXT,
        color TEXT NOT NULL,
        is_guest INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS docs (
        doc_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        structure_version INTEGER NOT NULL,
        data TEXT NOT NULL,
        owner_id TEXT,
        title TEXT NOT NULL DEFAULT '未命名文档',
        ro_token TEXT,
        enforce_owner_edit INTEGER NOT NULL DEFAULT 0,
        access_mode TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        doc_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, version)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_color TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS permission_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        message TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(doc_id, user_id, status)
      );
      CREATE TABLE IF NOT EXISTS doc_collaborators (
        doc_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (doc_id, user_id)
      );
    `);
    // 旧库幂等迁移：逐列补齐（已存在则忽略报错）
    for (const col of [
      "ALTER TABLE docs ADD COLUMN owner_id TEXT",
      "ALTER TABLE docs ADD COLUMN title TEXT NOT NULL DEFAULT '未命名文档'",
      "ALTER TABLE docs ADD COLUMN ro_token TEXT",
      "ALTER TABLE docs ADD COLUMN enforce_owner_edit INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE docs ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE docs ADD COLUMN access_mode TEXT",
      "ALTER TABLE docs ADD COLUMN icon TEXT",
      "ALTER TABLE docs ADD COLUMN deleted_at INTEGER",
    ]) {
      try {
        this.db.exec(col);
      } catch {
        /* 列已存在 */
      }
    }
    this.cleanupOldGuests();
    this.purgeOldTrash();
  }

  close() {
    this.db.close();
  }

  // --------------------------------------------------------------- 用户与认证

  private hashPassword(password: string, salt: string): string {
    return crypto.scryptSync(password, salt, 64).toString("hex");
  }

  /** 用户名是否可用（大小写不敏感；排除指定用户自身） */
  nameAvailable(username: string, excludeUserId?: string): boolean {
    const row = this.db
      .prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as { id: string } | undefined;
    if (!row) return true;
    return excludeUserId !== undefined && row.id === excludeUserId;
  }

  /** 注册：用户名全局唯一（UNIQUE + 预检查双保险）。成功返回 (用户, 会话token)。 */
  register(username: string, password: string): { user: UserRecord; token: string } {
    if (username.length < 2 || username.length > 24) throw new StoreError("用户名长度需在 2-24 个字符之间");
    if (/\s/.test(username)) throw new StoreError("用户名不能包含空白字符");
    if (password.length < 3) throw new StoreError("密码至少 3 个字符");
    if (!this.nameAvailable(username)) throw new StoreError(`用户名「${username}」已被占用`);
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString("hex");
    const color = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
    try {
      this.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, salt, color, is_guest, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
        )
        .run(id, username, this.hashPassword(password, salt), salt, color, Date.now());
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new StoreError(`用户名「${username}」已被占用`);
      throw err;
    }
    return { user: { id, username, color, isGuest: false }, token: this.createSession(id) };
  }

  login(username: string, password: string): { user: UserRecord; token: string } {
    const row = this.db
      .prepare(
        "SELECT id, username, color, password_hash, salt FROM users WHERE username = ? COLLATE NOCASE AND is_guest = 0",
      )
      .get(username) as
      | { id: string; username: string; color: string; password_hash: string | null; salt: string | null }
      | undefined;
    if (!row || !row.password_hash || !row.salt) throw new StoreError("用户名或密码错误");
    const got = Buffer.from(this.hashPassword(password, row.salt), "hex");
    const expect = Buffer.from(row.password_hash, "hex");
    // 长度一致时做常数时间比较，避免时序侧信道
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) {
      throw new StoreError("用户名或密码错误");
    }
    return {
      user: { id: row.id, username: row.username, color: row.color, isGuest: false },
      token: this.createSession(row.id),
    };
  }

  private createSession(userId: string): string {
    const token = crypto.randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
    return token;
  }

  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  /** token → 用户；无效返回 null */
  resolveToken(token: string): UserRecord | null {
    const row = this.db
      .prepare(
        "SELECT u.id, u.username, u.color, u.is_guest FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
      )
      .get(token) as { id: string; username: string; color: string; is_guest: number } | undefined;
    if (!row) return null;
    return { id: row.id, username: row.username, color: row.color, isGuest: row.is_guest === 1 };
  }

  /** 创建访客（用户名唯一：随机后缀碰撞时重试） */
  createGuest(preferredName?: string): { user: UserRecord; token: string } {
    let username = (preferredName && preferredName.trim().slice(0, 24)) || "";
    if (!username || !this.nameAvailable(username)) {
      for (let i = 0; i < 50; i++) {
        username = `访客-${crypto.randomBytes(2).toString("hex")}`;
        if (this.nameAvailable(username)) break;
      }
    }
    const id = crypto.randomUUID();
    const usedColors = new Set(
      (this.db.prepare("SELECT color FROM users WHERE id IN (SELECT user_id FROM sessions)").all() as { color: string }[]).map(
        (r) => r.color,
      ),
    );
    const color = USER_COLORS.find((c) => !usedColors.has(c)) ?? USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
    this.db
      .prepare("INSERT INTO users (id, username, password_hash, salt, color, is_guest, created_at) VALUES (?, ?, NULL, NULL, ?, 1, ?)")
      .run(id, username, color, Date.now());
    return { user: { id, username, color, isGuest: true }, token: this.createSession(id) };
  }

  /** 改名（访客与注册用户均可），全局唯一校验 */
  rename(userId: string, newName: string): UserRecord {
    const name = newName.trim().slice(0, 24);
    if (name.length < 1) throw new StoreError("名字不能为空");
    if (/\s/.test(name)) throw new StoreError("名字不能包含空白字符");
    if (!this.nameAvailable(name, userId)) throw new StoreError(`名字「${name}」已被占用`);
    this.db.prepare("UPDATE users SET username = ? WHERE id = ?").run(name, userId);
    const row = this.db.prepare("SELECT id, username, color, is_guest FROM users WHERE id = ?").get(userId) as {
      id: string;
      username: string;
      color: string;
      is_guest: number;
    };
    return { id: row.id, username: row.username, color: row.color, isGuest: row.is_guest === 1 };
  }

  getUser(userId: string): UserRecord | null {
    const row = this.db.prepare("SELECT id, username, color, is_guest FROM users WHERE id = ?").get(userId) as
      | { id: string; username: string; color: string; is_guest: number }
      | undefined;
    return row ? { id: row.id, username: row.username, color: row.color, isGuest: row.is_guest === 1 } : null;
  }

  /** 清理 7 天前的访客账号（注册用户永久保留） */
  private cleanupOldGuests() {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    this.db.exec(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_guest = 1 AND created_at < ${cutoff})`);
    this.db.exec(`DELETE FROM users WHERE is_guest = 1 AND created_at < ${cutoff}`);
  }

  // --------------------------------------------------------------- 文档与快照

  loadDoc(docId: string): DocState | null {
    const row = this.db.prepare("SELECT version, structure_version, data FROM docs WHERE doc_id = ? AND deleted_at IS NULL").get(docId) as
      | { version: number; structure_version: number; data: string }
      | undefined;
    if (row) {
      const parsed = JSON.parse(row.data) as { blocks: SrvBlock[] };
      return { docId, version: row.version, structureVersion: row.structure_version, blocks: parsed.blocks };
    }
    // 旧版 JSON 文件迁移（仅默认库；测试用的临时库不迁移）
    if (this.migrateLegacy) {
      try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_DOC_FILE, "utf-8")) as DocState & { blocks: SrvBlock[] };
        if (typeof legacy?.version === "number" && Array.isArray(legacy?.blocks)) {
          this.saveDoc({
            docId,
            version: legacy.version,
            structureVersion: legacy.structureVersion ?? 0,
            blocks: legacy.blocks,
          });
          return legacy;
        }
      } catch {
        /* 无旧文件 */
      }
    }
    return null;
  }

  saveDoc(state: DocState) {
    const data = JSON.stringify({ blocks: state.blocks });
    this.db
      .prepare(
        "INSERT INTO docs (doc_id, version, structure_version, data, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(doc_id) DO UPDATE SET version = excluded.version, structure_version = excluded.structure_version, data = excluded.data, updated_at = excluded.updated_at",
      )
      .run(state.docId, state.version, state.structureVersion, data, Date.now());
  }

  // ------------------------------------------------------------ 文档元信息

  getDocMeta(docId: string): { docId: string; ownerId: string | null; title: string; icon: string; enforceOwnerEdit: boolean; accessMode: "open" | "auth" | "restricted"; updatedAt: number; version: number } | null {
    const row = this.db
      .prepare("SELECT doc_id, owner_id, title, icon, enforce_owner_edit, access_mode, updated_at, version FROM docs WHERE doc_id = ? AND deleted_at IS NULL")
      .get(docId) as
      | { doc_id: string; owner_id: string | null; title: string; icon: string; enforce_owner_edit: number; access_mode: string | null; updated_at: number; version: number }
      | undefined;
    return row
      ? {
          docId: row.doc_id,
          ownerId: row.owner_id,
          title: row.title,
          icon: row.icon ?? "📄",
          enforceOwnerEdit: row.enforce_owner_edit === 1,
          accessMode: (row.access_mode as "open" | "auth" | "restricted") ?? (row.enforce_owner_edit === 1 ? "restricted" : "open"),
          updatedAt: row.updated_at,
          version: row.version,
        }
      : null;
  }

  /** 我的文档 + 公开示例（owner IS NULL），按更新时间倒序 */
  listDocs(userId: string): { docId: string; title: string; updatedAt: number; version: number; mine: boolean }[] {
    return (
      this.db
        .prepare(
          "SELECT doc_id, owner_id, title, icon, updated_at, version FROM docs WHERE deleted_at IS NULL AND (owner_id = ? OR owner_id IS NULL) ORDER BY (owner_id = ?) DESC, updated_at DESC",
        )
        .all(userId, userId) as { doc_id: string; owner_id: string | null; title: string; updated_at: number; version: number }[]
    ).map((r) => ({
      docId: r.doc_id,
      title: r.title,
      updatedAt: r.updated_at,
      version: r.version,
      mine: r.owner_id === userId,
    }));
  }

  /** 创建文档（仅注册用户）：可选初始块（Markdown 导入）；缺省首个块为 h1 标题 */
  createDoc(ownerId: string, title: string, initial?: BlockData[]): { docId: string; title: string } {
    const docId = crypto.randomUUID();
    const safeTitle = title.trim().slice(0, 60) || "未命名文档";
    const blocks = initial && initial.length > 0 ? initial : [{ id: crypto.randomUUID(), type: "h1" as const, text: safeTitle }];
    this.db
      .prepare(
        "INSERT INTO docs (doc_id, version, structure_version, data, owner_id, title, enforce_owner_edit, updated_at) VALUES (?, 0, 0, ?, ?, ?, 0, ?)",
      )
      .run(docId, JSON.stringify({ blocks }), ownerId, safeTitle, Date.now());
    return { docId, title: safeTitle };
  }

  setDocIcon(docId: string, icon: string) {
    this.db.prepare("UPDATE docs SET icon = ? WHERE doc_id = ?").run(icon.slice(0, 4), docId);
  }

  setDocTitle(docId: string, title: string) {
    this.db.prepare("UPDATE docs SET title = ? WHERE doc_id = ?").run(title.trim().slice(0, 60), docId);
    this.touchDoc(docId);
  }

  /** 设置访问模式：'open' | 'auth' | 'restricted' */
  setAccessMode(docId: string, mode: "open" | "auth" | "restricted") {
    this.db.prepare("UPDATE docs SET access_mode = ? WHERE doc_id = ?").run(mode, docId);
    // 同步旧字段（兼容旧客户端读取）
    this.db.prepare("UPDATE docs SET enforce_owner_edit = ? WHERE doc_id = ?").run(mode === "restricted" ? 1 : 0, docId);
  }

  /** 获取访问模式（access_mode 优先，回退到 enforceOwnerEdit） */
  getAccessMode(docId: string): "open" | "auth" | "restricted" {
    const row = this.db
      .prepare("SELECT access_mode, enforce_owner_edit FROM docs WHERE doc_id = ? AND deleted_at IS NULL")
      .get(docId) as { access_mode: string | null; enforce_owner_edit: number } | undefined;
    if (!row) return "open";
    if (row.access_mode === "open" || row.access_mode === "auth" || row.access_mode === "restricted") return row.access_mode;
    return row.enforce_owner_edit === 1 ? "restricted" : "open";
  }

  setEnforceOwnerEdit(docId: string, on: boolean) {
    this.db.prepare("UPDATE docs SET enforce_owner_edit = ? WHERE doc_id = ?").run(on ? 1 : 0, docId);
  }

  /** 只读链接令牌（懒生成） */
  readOnlyToken(docId: string): string {
    const row = this.db.prepare("SELECT ro_token FROM docs WHERE doc_id = ?").get(docId) as { ro_token: string | null } | undefined;
    if (row?.ro_token) return row.ro_token;
    const token = crypto.randomBytes(16).toString("hex");
    this.db.prepare("UPDATE docs SET ro_token = ? WHERE doc_id = ?").run(token, docId);
    return token;
  }

  /** 只读令牌 → docId */
  resolveReadOnly(roToken: string): string | null {
    const row = this.db.prepare("SELECT doc_id FROM docs WHERE ro_token = ?").get(roToken) as { doc_id: string } | undefined;
    return row?.doc_id ?? null;
  }

  deleteDoc(docId: string) {
    // 软删除进回收站（7 天后由 purgeOldTrash 物理清理）
    this.db.prepare("UPDATE docs SET deleted_at = ? WHERE doc_id = ?").run(Date.now(), docId);
  }

  restoreDoc(docId: string) {
    this.db.prepare("UPDATE docs SET deleted_at = NULL WHERE doc_id = ?").run(docId);
  }

  hardDeleteDoc(docId: string) {
    this.db.prepare("DELETE FROM comments WHERE doc_id = ?").run(docId);
    this.db.prepare("DELETE FROM doc_collaborators WHERE doc_id = ?").run(docId);
    this.db.prepare("DELETE FROM snapshots WHERE doc_id = ?").run(docId);
    this.db.prepare("DELETE FROM docs WHERE doc_id = ?").run(docId);
  }

  listTrash(userId: string): { docId: string; title: string; deletedAt: number }[] {
    return (
      this.db
        .prepare("SELECT doc_id, title, deleted_at FROM docs WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC")
        .all(userId) as { doc_id: string; title: string; deleted_at: number }[]
    ).map((r) => ({ docId: r.doc_id, title: r.title, deletedAt: r.deleted_at }));
  }

  /** 回收站行（含归属），供恢复/彻底删除的权限检查 */
  getTrashRow(docId: string): { docId: string; ownerId: string | null; deletedAt: number } | null {
    const row = this.db
      .prepare("SELECT doc_id, owner_id, deleted_at FROM docs WHERE doc_id = ? AND deleted_at IS NOT NULL")
      .get(docId) as { doc_id: string; owner_id: string | null; deleted_at: number } | undefined;
    return row ? { docId: row.doc_id, ownerId: row.owner_id, deletedAt: row.deleted_at } : null;
  }

  /** 物理清理回收站中超过 7 天的文档 */
  private purgeOldTrash() {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const stale = this.db
      .prepare("SELECT doc_id FROM docs WHERE deleted_at IS NOT NULL AND deleted_at < ?")
      .all(cutoff) as { doc_id: string }[];
    for (const r of stale) this.hardDeleteDoc(r.doc_id);
  }

  touchDoc(docId: string) {
    this.db.prepare("UPDATE docs SET updated_at = ? WHERE doc_id = ?").run(Date.now(), docId);
  }
  // ------------------------------------------------------------ 权限申请

  addPermissionRequest(docId: string, user: { id: string; username: string }, message?: string): { id: number } | { error: string } {
    const existing = this.db
      .prepare("SELECT id FROM permission_requests WHERE doc_id = ? AND user_id = ? AND status = 'pending'")
      .get(docId, user.id) as { id: number } | undefined;
    if (existing) return { error: "已有一条待处理的申请" };
    if (this.isCollaborator(docId, user.id)) return { error: "你已是协作者" };
    const r = this.db
      .prepare("INSERT INTO permission_requests (doc_id, user_id, user_name, message, created_at, status) VALUES (?, ?, ?, ?, ?, 'pending')")
      .run(docId, user.id, user.username, (message ?? "").slice(0, 200), Date.now());
    return { id: Number(r.lastInsertRowid) };
  }

  listPendingRequests(docId: string): PermissionRequest[] {
    return (
      this.db
        .prepare("SELECT id, user_id, user_name, message, created_at FROM permission_requests WHERE doc_id = ? AND status = 'pending' ORDER BY created_at ASC")
        .all(docId) as { id: number; user_id: string; user_name: string; message: string | null; created_at: number }[]
    ).map((r) => ({ id: r.id, userId: r.user_id, userName: r.user_name, message: r.message, createdAt: r.created_at }));
  }

  resolvePermissionRequest(requestId: number, approve: boolean): { userId: string; docId: string } | null {
    const row = this.db
      .prepare("SELECT id, doc_id, user_id FROM permission_requests WHERE id = ? AND status = 'pending'")
      .get(requestId) as { id: number; doc_id: string; user_id: string } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE permission_requests SET status = ? WHERE id = ?").run(approve ? "approved" : "rejected", requestId);
    if (approve) {
      this.db
        .prepare("INSERT OR IGNORE INTO doc_collaborators (doc_id, user_id, added_at) VALUES (?, ?, ?)")
        .run(row.doc_id, row.user_id, Date.now());
    }
    return { userId: row.user_id, docId: row.doc_id };
  }


  // ------------------------------------------------------------ 块级评论

  addComment(docId: string, blockId: string, user: { id: string; username: string; color: string }, body: string): import("../../shared/protocol").CommentData {
    const safe = body.trim().slice(0, 1000);
    const r = this.db
      .prepare(
        "INSERT INTO comments (doc_id, block_id, user_id, user_name, user_color, body, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      )
      .run(docId, blockId, user.id, user.username, user.color, safe, Date.now());
    return {
      id: Number(r.lastInsertRowid),
      blockId,
      userId: user.id,
      name: user.username,
      color: user.color,
      body: safe,
      createdAt: Date.now(),
      resolved: false,
    };
  }

  listComments(docId: string): import("../../shared/protocol").CommentData[] {
    return (
      this.db
        .prepare("SELECT id, block_id, user_id, user_name, user_color, body, created_at, resolved FROM comments WHERE doc_id = ? ORDER BY created_at ASC")
        .all(docId) as {
        id: number;
        block_id: string;
        user_id: string;
        user_name: string;
        user_color: string;
        body: string;
        created_at: number;
        resolved: number;
      }[]
    ).map((r) => ({
      id: r.id,
      blockId: r.block_id,
      userId: r.user_id,
      name: r.user_name,
      color: r.user_color,
      body: r.body,
      createdAt: r.created_at,
      resolved: r.resolved === 1,
    }));
  }

  /** 切换解决状态；返回新状态，评论不存在返回 null */
  toggleCommentResolve(docId: string, commentId: number): boolean | null {
    const row = this.db
      .prepare("SELECT resolved FROM comments WHERE id = ? AND doc_id = ?")
      .get(commentId, docId) as { resolved: number } | undefined;
    if (!row) return null;
    const next = row.resolved === 1 ? 0 : 1;
    this.db.prepare("UPDATE comments SET resolved = ? WHERE id = ?").run(next, commentId);
    return next === 1;
  }

  // ------------------------------------------------------------ 协作者名单

  isCollaborator(docId: string, userId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM doc_collaborators WHERE doc_id = ? AND user_id = ?").get(docId, userId);
  }

  listCollaborators(docId: string): { userId: string; name: string; color: string; addedAt: number }[] {
    return (
      this.db
        .prepare(
          "SELECT c.user_id, u.username, u.color, c.added_at FROM doc_collaborators c JOIN users u ON u.id = c.user_id WHERE c.doc_id = ? ORDER BY c.added_at ASC",
        )
        .all(docId) as { user_id: string; username: string; color: string; added_at: number }[]
    ).map((r) => ({ userId: r.user_id, name: r.username, color: r.color, addedAt: r.added_at }));
  }

  /** 按用户名邀请（用户必须存在）；返回被邀请者或抛 StoreError */
  addCollaborator(docId: string, username: string): { userId: string; name: string; color: string } {
    const user = this.db
      .prepare("SELECT id, username, color FROM users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as { id: string; username: string; color: string } | undefined;
    if (!user) throw new StoreError(`用户「${username.trim()}」不存在`);
    const meta = this.getDocMeta(docId);
    if (meta?.ownerId === user.id) throw new StoreError("创建者本身就拥有编辑权限");
    this.db
      .prepare("INSERT OR IGNORE INTO doc_collaborators (doc_id, user_id, added_at) VALUES (?, ?, ?)")
      .run(docId, user.id, Date.now());
    return { userId: user.id, name: user.username, color: user.color };
  }

  removeCollaborator(docId: string, userId: string) {
    this.db.prepare("DELETE FROM doc_collaborators WHERE doc_id = ? AND user_id = ?").run(docId, userId);
  }

  writeSnapshot(doc: DocSnapshot) {
    this.db
      .prepare(
        "INSERT INTO snapshots (doc_id, version, data, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(doc_id, version) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
      )
      .run(doc.docId, doc.version, JSON.stringify(doc), Date.now());
  }

  listSnapshots(docId: string): { version: number; ts: number }[] {
    return (
      this.db
        .prepare("SELECT version, created_at AS ts FROM snapshots WHERE doc_id = ? ORDER BY version DESC")
        .all(docId) as { version: number; ts: number }[]
    );
  }

  readSnapshot(docId: string, version: number): DocSnapshot | null {
    const row = this.db.prepare("SELECT data FROM snapshots WHERE doc_id = ? AND version = ?").get(docId, version) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as DocSnapshot) : null;
  }
}

export class StoreError extends Error {}

/** 演示文档标题（旧版种子升级判定用） */
export const DEMO_DOC_TITLE = "演示文档 · 所有人可编辑";
export const OLD_DEMO_TITLE = "示例文档（所有人可编辑）";

const DEMO_IMAGE_SRC =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" rx="12" fill="#1e293b"/><text x="160" y="58" font-size="22" font-family="sans-serif" fill="#e2e8f0" text-anchor="middle">Collab Blocks</text><text x="160" y="88" font-size="13" font-family="sans-serif" fill="#94a3b8" text-anchor="middle">图片块演示 · 粘贴图片自动压缩</text></svg>`,
  ).toString("base64");

/**
 * 首次运行的演示文档：覆盖全部块类型与核心功能，块 id 固定（供示例评论锚定）。
 * 旧库升级：index.ts 启动时检测旧标题并整篇替换。
 */
export function seedDoc(docId: string): DocState {
  const mk = (id: string, text: string, blockType: BlockType = "text", checked?: boolean, src?: string): SrvBlock => ({
    id,
    type: blockType,
    text,
    checked,
    ...(src ? { src } : {}),
    blockVersion: 0,
    lastWriter: "system",
  });
  return {
    docId,
    version: 0,
    structureVersion: 0,
    blocks: [
      mk("demo-title", "👋 演示文档 · 全功能一览", "h1"),
      mk(
        "demo-intro",
        "这篇文档演示所有功能，人人可编辑。先开两个标签页打开本页，感受实时同步：远程光标、选区高亮、块锁（对方正在编辑的块会出现 🔒 提示）。",
      ),
      mk("demo-h2-types", "① 七种块类型", "h2"),
      mk("demo-t-bullet-1", "输入 / 唤起块类型菜单；# + 空格、- + 空格、[ ] + 空格、``` 是 Markdown 快捷输入", "bullet"),
      mk("demo-t-bullet-2", "待办事项可以点勾选，双端实时同步：", "bullet"),
      mk("demo-todo-1", "点我勾选 / 取消勾选（可 Ctrl+Z 撤销）", "todo", false),
      mk("demo-todo-2", "已完成的待办（删除线样式）", "todo", true),
      mk(
        "demo-code",
        '// 代码块：桌面 Shift+Enter 块内换行、Enter 跳出；\n// 手机上回车直接换行，点右上「退出」按钮离开代码块\nfunction hello(name) {\n  return `你好，${name}！`;\n}\nconsole.log(hello("Collab Blocks"));',
        "code",
      ),
      mk("demo-image", "图片块：粘贴或拖入图片自动压缩", "image", undefined, DEMO_IMAGE_SRC),
      mk("demo-h2-collab", "② 多人协同", "h2"),
      mk(
        "demo-comments",
        "块级评论：悬停本块左侧点 💬 可新建评论线程（下方已有一条示例评论）；评论支持 @提及 和桌面通知，全部永久存储在服务端 SQLite 数据库，重启不丢。",
      ),
      mk("demo-presence", "右上角是在线用户列表，实时显示谁在编辑；底部状态栏显示连接状态、版本与待同步事务。"),
      mk("demo-h2-tools", "③ 搜索 / 大纲 / 快照 / 导出", "h2"),
      mk("demo-tools", "Ctrl+F 全文搜索（高亮 + 跳转）；左侧大纲点击跳转标题；右上「快照」查看/恢复历史版本；「导出」支持 Markdown / 纯文本 / HTML 复制与 .md 下载，还能导入 .md 生成文档。"),
      mk("demo-h2-mobile", "④ 手机端", "h2"),
      mk("demo-mobile", "手机可直接访问，已做触控适配：评论入口常显、多选工具栏自动换行、代码块回车即换行（点代码块右上「退出」按钮可离开）。"),
      mk("demo-h2-play", "⑤ 动手试试", "h2"),
      mk("demo-play-1", "同时编辑本块做冲突实验：两个标签页各自输入，看输入如何被保留", "bullet"),
      mk("demo-play-2", "删除我再 Ctrl+Z 撤销回来", "bullet"),
      mk("demo-play-3", "拖动块左侧 ⠿ 把我移到别处", "bullet"),
    ],
  };
}

/** 内置功能说明文档（所有人可见，服务端强制只读；每次启动以种子覆盖保持与版本同步） */
export function seedHelpDoc(docId: string): DocState {
  const mk = (text: string, blockType: BlockType = "text"): SrvBlock => ({
    id: `help-${crypto.randomUUID().slice(0, 8)}`,
    type: blockType,
    text,
    blockVersion: 0,
    lastWriter: "system",
  });
  return {
    docId,
    version: 0,
    structureVersion: 0,
    blocks: [
      mk("📖 Collab Blocks 功能说明（只读）", "h1"),
      mk("本文档为内置说明，所有人可见、不可编辑。想动手体验请打开「演示文档」。"),
      mk("快捷键与输入", "h2"),
      mk("输入 / 唤起块类型菜单（支持拼音/英文过滤，↑↓ 选择，Enter 确认）", "bullet"),
      mk("Markdown 快捷输入：# / ## / ### + 空格 → 标题；- * + 空格 → 列表；[ ] / [x] + 空格 → 待办；``` → 代码块（触发串需独占整块）", "bullet"),
      mk("代码块：桌面 Enter 跳出到下方新建正文块、Shift+Enter 块内换行；手机 Enter 直接块内换行，点块右上「退出」按钮跳出到下方正文块", "bullet"),
      mk("多行文本粘贴自动按行拆块（代码块内则整体并入保留换行）；粘贴图片自动压缩为图片块", "bullet"),
      mk("Ctrl+F 搜索；Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 撤销重做；? 打开快捷键面板；Shift+点击 或 Shift+↑↓ 多选块后批量转类型/删除", "bullet"),
      mk("块手势：块首 Backspace 非正文块转正文；空列表/待办回车转正文；拖动 ⠿ 排序", "bullet"),
      mk("权限与分享", "h2"),
      mk("三档权限：开放（任何人可编辑）/ 登录可编辑 / 受限（仅创建者与协作者可编辑）", "bullet"),
      mk("分享双轨：编辑链接（/d/文档ID 即凭据）/ 只读链接（/r/令牌，整页禁编辑）；受限文档可发起编辑权限申请，创建者审批", "bullet"),
      mk("回收站：删除的文档 7 天内可恢复", "bullet"),
      mk("协同能力", "h2"),
      mk("实时同步（WebSocket）：远程光标与跨块选区高亮、块锁（15s TTL 自动过期）、乐观更新 + 事务原子提交 + ACK + 幂等重发 + 断线重连对账补发", "bullet"),
      mk("冲突处理：块级 CAS，不同块并发无冲突；同块并发自动变换合并重试，双方输入保留", "bullet"),
      mk("块级评论：悬停块左侧 💬 发起评论；支持回复、标记解决、@提及、桌面通知、未读角标；评论永久存储于 SQLite，重启不丢失", "bullet"),
      mk("快照：每 50 个版本自动落一份，可查看、对比、恢复任意历史版本（恢复本身是可撤销的事务）", "bullet"),
      mk("数据与部署", "h2"),
      mk("数据全部持久化在服务端 SQLite（node:sqlite，WAL 模式）：用户/会话/文档/快照/评论每次提交即落盘，重启零丢失", "bullet"),
      mk("在线体验地址见 README；部署于 Linux（宝塔面板）单进程 Node 服务，HTTP 与 WebSocket 同端口", "bullet"),
      mk("已知限制", "h2"),
      mk("撤销不感知他人对同一块的修改；块内暂无富文本样式（加粗/斜体）；HTTP 暂未加 TLS；单进程部署（多进程需 Redis 广播）", "bullet"),
    ],
  };
}

// ------------------------------------------------------------ 权限申请

export interface PermissionRequest {
  id: number;
  userId: string;
  userName: string;
  message: string | null;
  createdAt: number;
}
