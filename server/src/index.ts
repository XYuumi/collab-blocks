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
    const { title } = req.body ?? {};
    const created = store.createDoc(user.id, typeof title === "string" ? title : "未命名文档");
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
    docs.unload(meta.docId);
    store.deleteDoc(meta.docId);
    res.json({ ok: true });
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
  buildServer().listen(PORT).then(({ port }) => {
    console.log(`[server] listening on http://localhost:${port} (ws: /ws)`);
  });
}
