/**
 * 服务器入口：HTTP(Express) + WebSocket 同端口。
 * - /ws                      WebSocket（连接绑定文档，Origin 校验，maxPayload 512KB）
 * - /api/auth/*              注册 / 登录 / 登出 / 改名
 * - /api/docs                文档列表 / 创建（登录）；/api/docs/:id 改名·开关·删除（创建者）
 * - /api/ro/:token           只读链接 → docId
 * - /api/docs/:docId/snapshots…  快照（列表/内容）
 * - 其余路径                  托管 client/dist（SPA：/ 首页、/d/:docId 编辑、/r/:token 只读）
 */
import express, { type Request, type Response } from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { DOC_ID } from "../../shared/protocol";
import { randomUUID } from "node:crypto";
import { DocManager } from "./docmanager";
import { Hub } from "./hub";
import { Store, seedDoc, StoreError } from "./store";
import type { DocEngine } from "./engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

export interface AppServer {
  app: express.Express;
  engine: DocEngine; // 内置示例文档的引擎（测试/兼容用）
  docs: DocManager;
  hub: Hub;
  store: Store;
  listen: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
}

function readToken(req: Request): string {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return (req.body as { token?: string } | undefined)?.token ?? "";
}

export function buildServer(dbPath?: string): AppServer {
  const store = new Store(dbPath ?? undefined, { migrateLegacy: !dbPath });
  const docs = new DocManager(store);

  // 内置示例文档（无归属，所有人可见；旧库自动迁移保留内容）
  const sample = store.loadDoc(DOC_ID) ?? seedDoc(DOC_ID);
  const sampleEngine = docs.preload(sample);
  const sampleMeta = store.getDocMeta(DOC_ID);
  if (sampleMeta && sampleMeta.title === "未命名文档") {
    store.setDocTitle(DOC_ID, "示例文档（所有人可编辑）");
  }

  const hub = new Hub(store, docs);

  const app = express();
  app.use("/api/auth", express.json({ limit: "16kb" }));
  app.use("/api/docs", express.json({ limit: "16kb" }));

  const authErr = (res: Response, err: unknown) => {
    if (err instanceof StoreError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error("[api]", err);
      res.status(500).json({ error: "服务器内部错误" });
    }
  };

  // ------------------------------------------------------------ 认证
  app.post("/api/auth/register", (req: Request, res: Response) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "参数不完整" });
        return;
      }
      const r = store.register(username, password);
      res.json({ token: r.token, user: r.user });
    } catch (err) {
      authErr(res, err);
    }
  });

  app.post("/api/auth/login", (req: Request, res: Response) => {
    try {
      const { username, password } = req.body ?? {};
      if (typeof username !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "参数不完整" });
        return;
      }
      const r = store.login(username, password);
      res.json({ token: r.token, user: r.user });
    } catch (err) {
      authErr(res, err);
    }
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    const token = readToken(req);
    if (token) store.logout(token);
    res.json({ ok: true });
  });

  app.post("/api/auth/rename", (req: Request, res: Response) => {
    try {
      const { token, name } = req.body ?? {};
      if (typeof token !== "string" || typeof name !== "string") {
        res.status(400).json({ error: "参数不完整" });
        return;
      }
      const user = store.resolveToken(token);
      if (!user) {
        res.status(401).json({ error: "登录态已失效" });
        return;
      }
      const updated = store.rename(user.id, name);
      hub.refreshUser(user.id);
      res.json({ user: updated });
    } catch (err) {
      authErr(res, err);
    }
  });

  // ------------------------------------------------------------ 文档
  app.get("/api/docs", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    res.json({ docs: store.listDocs(user.id), user: { name: user.username, color: user.color, isGuest: user.isGuest } });
  });

  app.post("/api/docs", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    if (user.isGuest) {
      res.status(403).json({ error: "访客不能创建文档，请先注册登录" });
      return;
    }
    const { title, blocks } = req.body ?? {};
    // blocks：Markdown 导入等场景的初始内容（校验形状与规模，id 服务端补齐）
    let initial: import("../../shared/protocol").BlockData[] | null = null;
    if (Array.isArray(blocks)) {
      if (blocks.length > 2000) {
        res.status(400).json({ error: "内容过大（最多 2000 块）" });
        return;
      }
      initial = blocks
        .filter((b: unknown) => b && typeof b === "object")
        .slice(0, 2000)
        .map((b: { id?: unknown; type?: unknown; text?: unknown; checked?: unknown }) => ({
          id: typeof b.id === "string" && b.id ? b.id : randomUUID(),
          type: (["text", "h1", "h2", "h3", "bullet", "todo", "code", "image"] as const).includes(b.type as never)
            ? (b.type as import("../../shared/protocol").BlockType)
            : "text",
          text: typeof b.text === "string" ? b.text.slice(0, 100_000) : "",
          ...(b.checked === true ? { checked: true } : {}),
        }));
    }
    const created = store.createDoc(user.id, typeof title === "string" ? title : "未命名文档", initial ?? undefined);
    res.json({ docId: created.docId, title: created.title });
  });

  app.get("/api/docs/:docId/meta", (req: Request, res: Response) => {
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    const user = store.resolveToken(readToken(req));
    res.json({
      docId: meta.docId,
      title: meta.title,
      enforceOwnerEdit: meta.enforceOwnerEdit,
      accessMode: (meta as { accessMode?: string }).accessMode ?? (meta.enforceOwnerEdit ? "restricted" : "open"),
      isOwner: !!user && user.id === meta.ownerId,
    });
  });

  app.patch("/api/docs/:docId", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    if (meta.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以修改文档设置" });
      return;
    }
    const { title, enforceOwnerEdit } = req.body ?? {};
    if (typeof title === "string" && title.trim()) store.setDocTitle(meta.docId, title);
    if (typeof enforceOwnerEdit === "boolean") store.setEnforceOwnerEdit(meta.docId, enforceOwnerEdit);
    if (req.body?.accessMode === "open" || req.body?.accessMode === "auth" || req.body?.accessMode === "restricted") {
      store.setAccessMode(meta.docId, req.body.accessMode);
    }
    res.json({ ok: true, meta: store.getDocMeta(meta.docId) });
  });

  app.delete("/api/docs/:docId", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    if (meta.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以删除文档" });
      return;
    }
    store.deleteDoc(req.params.docId); // 软删除进回收站（7 天可恢复）
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 回收站
  app.get("/api/docs/trash/list", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    res.json({ docs: store.listTrash(user.id) });
  });

  app.post("/api/docs/:docId/restore", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const row = store.getTrashRow(req.params.docId);
    if (!row) {
      res.status(404).json({ error: "回收站中没有该文档" });
      return;
    }
    if (row.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以恢复" });
      return;
    }
    if (Date.now() - row.deletedAt > 7 * 24 * 3600 * 1000) {
      res.status(400).json({ error: "已超过 7 天保留期" });
      return;
    }
    store.restoreDoc(req.params.docId);
    res.json({ ok: true });
  });

  app.post("/api/docs/:docId/purge", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const row = store.getTrashRow(req.params.docId);
    if (!row) {
      res.status(404).json({ error: "回收站中没有该文档" });
      return;
    }
    if (row.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以彻底删除" });
      return;
    }
    docs.unload(req.params.docId);
    store.hardDeleteDoc(req.params.docId);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 协作者名单
  app.get("/api/docs/:docId/collaborators", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    res.json({ collaborators: store.listCollaborators(req.params.docId) });
  });

  app.post("/api/docs/:docId/collaborators", (req: Request, res: Response) => {
    try {
      const user = store.resolveToken(readToken(req));
      if (!user) {
        res.status(401).json({ error: "请先登录" });
        return;
      }
      const meta = store.getDocMeta(req.params.docId);
      if (!meta) {
        res.status(404).json({ error: "文档不存在" });
        return;
      }
      if (meta.ownerId !== user.id) {
        res.status(403).json({ error: "只有创建者可以邀请协作者" });
        return;
      }
      const { username } = req.body ?? {};
      if (typeof username !== "string" || !username.trim()) {
        res.status(400).json({ error: "请填写用户名" });
        return;
      }
      const added = store.addCollaborator(req.params.docId, username);
      res.json({ collaborator: added });
    } catch (err) {
      authErr(res, err);
    }
  });

  app.delete("/api/docs/:docId/collaborators/:userId", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    if (meta.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以移除协作者" });
      return;
    }
    store.removeCollaborator(req.params.docId, req.params.userId);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 权限申请
  app.post("/api/docs/:docId/request", (req: Request, res: Response) => {
    try {
      const user = store.resolveToken(readToken(req));
      if (!user) {
        res.status(401).json({ error: "请先登录" });
        return;
      }
      const meta = store.getDocMeta(req.params.docId);
      if (!meta) {
        res.status(404).json({ error: "文档不存在" });
        return;
      }
      const mode = store.getAccessMode(req.params.docId);
      if (mode === "open") {
        res.status(400).json({ error: "本文档已开放编辑，无需申请" });
        return;
      }
      if (meta.ownerId === user.id) {
        res.status(400).json({ error: "你是创建者，无需申请" });
        return;
      }
      const { message } = req.body ?? {};
      const r = store.addPermissionRequest(req.params.docId, user, typeof message === "string" ? message : undefined);
      if ("error" in r) {
        res.status(400).json({ error: r.error });
        return;
      }
      // 通知 owner（如果有在线会话则刷新分享面板）
      if (meta.ownerId) hub.refreshUser(meta.ownerId);
      res.json({ ok: true });
    } catch (err) {
      authErr(res, err);
    }
  });

  app.get("/api/docs/:docId/requests", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta || meta.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以查看申请" });
      return;
    }
    res.json({ requests: store.listPendingRequests(req.params.docId) });
  });

  app.post("/api/docs/:docId/requests/:id/:action", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta || meta.ownerId !== user.id) {
      res.status(403).json({ error: "只有创建者可以处理申请" });
      return;
    }
    const approve = req.params.action === "approve";
    const result = store.resolvePermissionRequest(Number(req.params.id), approve);
    if (!result) {
      res.status(404).json({ error: "申请不存在或已处理" });
      return;
    }
    res.json({ ok: true, approved: approve });
  });

  // ------------------------------------------------------------ 块级评论
  /** 与 hello 一致的角色判定：enforce 开启时非 owner 不可评论 */
  const canComment = (meta: { ownerId: string | null; enforceOwnerEdit: boolean }, userId: string) =>
    !(meta.ownerId && meta.enforceOwnerEdit && meta.ownerId !== userId);

  app.get("/api/docs/:docId/comments", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录（访客也可）" });
      return;
    }
    if (!store.getDocMeta(req.params.docId)) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    res.json({ comments: store.listComments(req.params.docId) });
  });

  app.post("/api/docs/:docId/comments", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录（访客也可）" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    if (!canComment(meta, user.id)) {
      res.status(403).json({ error: "当前为仅创建者可编辑模式，无法评论" });
      return;
    }
    const { blockId, body } = req.body ?? {};
    if (typeof blockId !== "string" || typeof body !== "string" || !body.trim()) {
      res.status(400).json({ error: "参数不完整" });
      return;
    }
    const engine = docs.get(req.params.docId);
    if (!engine || !engine.state.blocks.some((b) => b.id === blockId)) {
      res.status(400).json({ error: "目标块不存在" });
      return;
    }
    const comment = store.addComment(req.params.docId, blockId, user, body);
    hub.broadcastComment(req.params.docId, comment);
    res.json({ comment });
  });

  app.post("/api/docs/:docId/comments/:id/resolve", (req: Request, res: Response) => {
    const user = store.resolveToken(readToken(req));
    if (!user) {
      res.status(401).json({ error: "请先登录" });
      return;
    }
    const meta = store.getDocMeta(req.params.docId);
    if (!meta) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    if (!canComment(meta, user.id)) {
      res.status(403).json({ error: "无权操作" });
      return;
    }
    const id = Number(req.params.id);
    const resolved = Number.isInteger(id) ? store.toggleCommentResolve(req.params.docId, id) : null;
    if (resolved === null) {
      res.status(404).json({ error: "评论不存在" });
      return;
    }
    res.json({ ok: true, resolved });
  });

  // 只读链接令牌（懒生成；docId 本身即编辑凭据，故不限制获取者）
  app.get("/api/docs/:docId/ro", (req: Request, res: Response) => {
    if (!store.getDocMeta(req.params.docId)) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    res.json({ token: store.readOnlyToken(req.params.docId) });
  });

  // 只读链接 → docId（公开映射，不含其它信息）
  app.get("/api/ro/:token", (req: Request, res: Response) => {
    const docId = store.resolveReadOnly(req.params.token);
    if (!docId) {
      res.status(404).json({ error: "链接无效" });
      return;
    }
    res.json({ docId });
  });

  // ------------------------------------------------------------ 快照
  app.get("/api/docs/:docId/snapshots", (req: Request, res: Response) => {
    if (!store.getDocMeta(req.params.docId)) {
      res.status(404).json({ error: "文档不存在" });
      return;
    }
    res.json(store.listSnapshots(req.params.docId));
  });

  app.get("/api/docs/:docId/snapshots/:version", (req: Request, res: Response) => {
    const v = Number(req.params.version);
    const doc = Number.isInteger(v) ? store.readSnapshot(req.params.docId, v) : null;
    if (!doc) res.status(404).json({ error: "snapshot not found" });
    else res.json(doc);
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: sampleEngine.state.version, online: hub.onlineCount, docs: docs.size });
  });

  // 生产模式：托管打包后的前端（SPA fallback）
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
      res.sendFile(path.join(CLIENT_DIST, "index.html"));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });
  hub.attach(wss);

  return {
    app,
    engine: sampleEngine,
    docs,
    hub,
    store,
    listen: (port = 0) =>
      new Promise((resolve) => {
        server.listen(port, () => {
          const actual = (server.address() as { port: number }).port;
          resolve({
            port: actual,
            close: async () => {
              hub.close();
              wss.close();
              await new Promise<void>((r2) => server.close(() => r2()));
              store.close();
            },
          });
        });
      }),
  };
}

// 直接运行（tsx src/index.ts / node dist/index.js）时启动 3000 端口
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const PORT = Number(process.env.PORT || 3000);
  // E2E_DB：端到端测试注入临时库路径
  buildServer(process.env.E2E_DB).listen(PORT).then(({ port }) => {
    console.log(`[server] listening on http://localhost:${port} (ws: /ws)`);
  });
}
