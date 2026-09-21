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

  getDocMeta(docId: string): { docId: string; ownerId: string | null; title: string; enforceOwnerEdit: boolean; updatedAt: number; version: number } | null {
    const row = this.db
      .prepare("SELECT doc_id, owner_id, title, icon, enforce_owner_edit, updated_at, version FROM docs WHERE doc_id = ? AND deleted_at IS NULL")
      .get(docId) as
      | { doc_id: string; owner_id: string | null; title: string; enforce_owner_edit: number; updated_at: number; version: number }
      | undefined;
    return row
      ? {
          docId: row.doc_id,
          ownerId: row.owner_id,
          title: row.title,
          enforceOwnerEdit: row.enforce_owner_edit === 1,
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

/** 首次运行的种子文档（含块类型演示） */
export function seedDoc(docId: string): DocState {
  const mk = (text: string, blockType: BlockType = "text", checked?: boolean): SrvBlock => ({
    id: `seed-${crypto.randomUUID().slice(0, 8)}`,
    type: blockType,
    text,
    checked,
    blockVersion: 0,
    lastWriter: "system",
  });
  return {
    docId,
    version: 0,
    structureVersion: 0,
    blocks: [
      mk("👋 欢迎来到协同编辑器", "h1"),
      mk("基于 DOM 渲染的块结构编辑器：输入 / 唤起块类型菜单（标题、列表、待办、代码块）。"),
      mk("两个标签页打开本页即可协作：实时同步、远程光标、块锁、断线重连补发。", "bullet"),
      mk("注册登录后颜色与身份固定；不登录则以访客身份协作。", "bullet"),
      mk("试试勾选这个待办事项", "todo", false),
      mk("console.log('代码块也支持协同编辑')", "code"),
      mk("支持：乐观更新、事务、ACK、幂等重发、块级 CAS 冲突合并、撤销/重做、快照。设计文档见 docs/。"),
      mk("这一行留给你们做“同时编辑同一个块”的冲突实验。"),
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
