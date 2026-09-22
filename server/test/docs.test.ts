/**
 * 多文档与权限测试：文档 CRUD / 房间隔离 / 角色矩阵（owner·editor·viewer）/ doc.replace。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { buildServer } from "../src/index";
import { DOC_ID, HELP_DOC_ID, type ServerMsg, type Tx } from "../../shared/protocol";

function tmpDb() {
  return path.join(os.tmpdir(), `collab-docs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

class C {
  ws: WebSocket;
  received: ServerMsg[] = [];
  constructor(port: number, public docId: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (d) => this.received.push(JSON.parse(String(d))));
  }
  async open() {
    await new Promise<void>((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
    return this;
  }
  hello(token?: string, mode?: "view") {
    this.ws.send(JSON.stringify({ t: "hello", docId: this.docId, token, mode }));
    return this.waitInit();
  }
  async waitInit() {
    return this.waitFor((m) => m.t === "init") as Promise<Extract<ServerMsg, { t: "init" }>>;
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
  tx(engine: { state: { version: number; docId: string; blocks: { id: string }[] } }, author: string, ops: Tx["ops"], txId: string) {
    this.send({
      t: "tx",
      tx: { txId, docId: engine.state.docId, baseVersion: engine.state.version, author, ts: Date.now(), ops },
    });
  }
  async waitFor(pred: (m: ServerMsg) => boolean, timeout = 3000): Promise<ServerMsg> {
    const found = this.received.find(pred);
    if (found) return found;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("waitFor timeout")), timeout);
      const on = () => {
        const m = this.received.find(pred);
        if (m) {
          clearTimeout(timer);
          this.ws.off("message", on);
          res(m);
        }
      };
      this.ws.on("message", on);
    });
  }
  async close() {
    this.ws.close();
    await new Promise<void>((res) => {
      if (this.ws.readyState === WebSocket.CLOSED) res();
      else this.ws.once("close", res);
    });
  }
}

test("REST：文档 CRUD 与归属（登录才能建，示例文档全员可见）", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const base = `http://127.0.0.1:${l.port}`;
  try {
    const reg = await (await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner1", password: "pass123" }) })).json() as { token: string };
    const guest = s.store.createGuest();
    // 访客不能建
    const g = await fetch(`${base}/api/docs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${guest.token}` }, body: JSON.stringify({ title: "x" }) });
    assert.equal(g.status, 403);
    // 未登录看不到列表
    const noauth = await fetch(`${base}/api/docs`);
    assert.equal(noauth.status, 401);
    // 创建
    const created = (await (await fetch(`${base}/api/docs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ title: "我的计划" }) })).json()) as { docId: string; title: string };
    assert.equal(created.title, "我的计划");
    // 列表 = 我的 + 内置演示文档 + 内置功能说明文档（均无归属、全员可见）
    const list = (await (await fetch(`${base}/api/docs`, { headers: { Authorization: `Bearer ${reg.token}` } })).json()) as { docs: { docId: string; mine: boolean }[] };
    assert.equal(list.docs.length, 3);
    assert.ok(list.docs.some((d) => d.docId === created.docId && d.mine));
    assert.ok(list.docs.some((d) => d.docId === DOC_ID && !d.mine));
    assert.ok(list.docs.some((d) => d.docId === HELP_DOC_ID && !d.mine));
    // 改名 + enforce 开关
    const patch = await fetch(`${base}/api/docs/${created.docId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ title: "改名了", enforceOwnerEdit: true }) });
    assert.equal(patch.status, 200);
    const meta = (await (await fetch(`${base}/api/docs/${created.docId}/meta`)).json()) as { title: string; enforceOwnerEdit: boolean };
    assert.equal(meta.title, "改名了");
    assert.equal(meta.enforceOwnerEdit, true);
    // 删除
    const del = await fetch(`${base}/api/docs/${created.docId}`, { method: "DELETE", headers: { Authorization: `Bearer ${reg.token}` } });
    assert.equal(del.status, 200);
    const after = (await (await fetch(`${base}/api/docs`, { headers: { Authorization: `Bearer ${reg.token}` } })).json()) as { docs: unknown[] };
    assert.equal(after.docs.length, 2); // 剩两个内置文档（演示 + 功能说明）
  } finally {
    await l.close();
  }
});

test("内置功能说明文档：全员只读（WS 角色强制 viewer + 评论/写操作被拒）", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const someone = s.store.register("helpreader", "pass123");
  const c = await new C(l.port, HELP_DOC_ID).open();
  try {
    const init = await c.hello(someone.token);
    assert.equal(init.role, "viewer"); // 无论登录与否一律只读
    const engine = s.docs.get(HELP_DOC_ID)!;
    const blk = engine.state.blocks[0];
    c.tx(engine, someone.user.id, [{ type: "text.insert", blockId: blk.id, offset: 0, text: "x" }], "h1");
    await c.waitFor((m) => m.t === "error");
    // REST 评论同样被拒
    const cm = await fetch(`http://127.0.0.1:${l.port}/api/docs/${HELP_DOC_ID}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${someone.token}` },
      body: JSON.stringify({ blockId: blk.id, body: "hi" }),
    });
    assert.equal(cm.status, 403);
  } finally {
    await c.close();
    await l.close();
  }
});

test("房间隔离：两个文档的广播/presence 互不串扰", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const alice = s.store.register("alice", "pass123");
  const d1 = s.store.createDoc(alice.user.id, "A 文档");
  const d2 = s.store.createDoc(alice.user.id, "B 文档");
  const e1 = s.docs.get(d1.docId)!;
  const a1 = await new C(l.port, d1.docId).open();
  const b1 = await new C(l.port, d1.docId).open();
  const c2 = await new C(l.port, d2.docId).open();
  try {
    await a1.hello(alice.token);
    await b1.hello(alice.token);
    await c2.hello(alice.token);
    // 文档1 有 2 人，文档2 有 1 人
    const p1 = await a1.waitFor((m) => m.t === "presence" && m.users.length === 2);
    void p1;
    // 在文档1 提交 → 文档2 的会话不应收到任何 remote.op
    const blk = e1.state.blocks[0];
    a1.tx(e1, alice.user.id, [{ type: "text.insert", blockId: blk.id, offset: 0, text: "hi" }], "t1");
    await a1.waitFor((m) => m.t === "ack" && m.txId === "t1");
    await b1.waitFor((m) => m.t === "remote.op" && m.tx.txId === "t1");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c2.received.some((m) => m.t === "remote.op"), false);
    assert.equal(c2.received.some((m) => m.t === "presence" && m.users.length === 2), false);
  } finally {
    await a1.close();
    await b1.close();
    await c2.close();
    await l.close();
  }
});

test("权限矩阵：viewer 拒写；enforceOwnerEdit 开启后非创建者只读；创建者不受影响", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const owner = s.store.register("boss", "pass123");
  const other = s.store.register("guest2", "pass123");
  const d = s.store.createDoc(owner.user.id, "权限测试");
  const engine = s.docs.get(d.docId)!;
  const oc = await new C(l.port, d.docId).open();
  const xc = await new C(l.port, d.docId).open();
  const roToken = s.store.readOnlyToken(d.docId);
  const vc = await new C(l.port, d.docId).open();
  try {
    const oi = await oc.hello(owner.token);
    assert.equal(oi.role, "owner");
    const xi = await xc.hello(other.token);
    assert.equal(xi.role, "editor");
    const vi = await vc.hello(other.token, "view");
    assert.equal(vi.role, "viewer");

    // viewer 发 tx → 被拒（收到 error，且无 ack）
    const blk = engine.state.blocks[0];
    vc.tx(engine, other.user.id, [{ type: "text.insert", blockId: blk.id, offset: 0, text: "x" }], "v1");
    await vc.waitFor((m) => m.t === "error");
    assert.equal(vc.received.some((m) => m.t === "ack" && m.txId === "v1"), false);
    // editor 正常可写
    xc.tx(engine, other.user.id, [{ type: "text.insert", blockId: blk.id, offset: 0, text: "E" }], "e1");
    await xc.waitFor((m) => m.t === "ack" && m.txId === "e1");

    // 开启"仅创建者可编辑"：新的非 owner 连接降为 viewer
    s.store.setEnforceOwnerEdit(d.docId, true);
    const xc2 = await new C(l.port, d.docId).open();
    const xi2 = await xc2.hello(other.token);
    assert.equal(xi2.role, "viewer");
    // 已连接的 owner 仍可写
    oc.tx(engine, owner.user.id, [{ type: "text.insert", blockId: blk.id, offset: 0, text: "O" }], "o1");
    await oc.waitFor((m) => m.t === "ack" && m.txId === "o1");
    await xc2.close();

    // 只读链接 REST 解析
    const ro = (await (await fetch(`http://127.0.0.1:${l.port}/api/ro/${roToken}`)).json()) as { docId: string };
    assert.equal(ro.docId, d.docId);
  } finally {
    await oc.close();
    await xc.close();
    await vc.close();
    await l.close();
  }
});

test("doc.replace：快照恢复原子生效、广播、客户端重放收敛", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const alice = s.store.register("alice", "pass123");
  const d = s.store.createDoc(alice.user.id, "恢复测试");
  const engine = s.docs.get(d.docId)!;
  const a = await new C(l.port, d.docId).open();
  const b = await new C(l.port, d.docId).open();
  try {
    await a.hello(alice.token);
    await b.hello(alice.token);
    // 恢复到给定块集合
    const restoreBlocks = [
      { id: "r1", type: "h1" as const, text: "恢复后的标题" },
      { id: "r2", type: "text" as const, text: "恢复后的正文" },
    ];
    a.tx(engine, alice.user.id, [{ type: "doc.replace", blocks: restoreBlocks }], "restore1");
    await a.waitFor((m) => m.t === "ack" && m.txId === "restore1");
    await b.waitFor((m) => m.t === "remote.op" && m.tx.txId === "restore1");
    assert.deepEqual(
      engine.state.blocks.map((x) => x.text),
      ["恢复后的标题", "恢复后的正文"],
    );
    assert.equal(engine.state.version, 1);
    // 持久化到 SQLite
    const meta = s.store.getDocMeta(d.docId);
    assert.equal(meta?.version, 1);
    // 非法 doc.replace（重复 id）被拒
    a.tx(engine, alice.user.id, [{ type: "doc.replace", blocks: [{ id: "z", type: "text", text: "a" }, { id: "z", type: "text", text: "b" }] }], "bad");
    const nack = await a.waitFor((m) => m.t === "nack" && m.txId === "bad");
    assert.ok(nack.t === "nack" && nack.reason === "INVALID");
  } finally {
    await a.close();
    await b.close();
    await l.close();
  }
});
