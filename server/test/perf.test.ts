/**
 * v7 功能与性能护栏测试：协作者名单、image 块、千块级冒烟。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { buildServer } from "../src/index";
import type { ServerMsg, Tx } from "../../shared/protocol";

function tmpDb() {
  return path.join(os.tmpdir(), `collab-v7-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
  hello(token?: string) {
    this.ws.send(JSON.stringify({ t: "hello", docId: this.docId, token }));
    return this.waitFor((m) => m.t === "init");
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
  tx(engine: { state: { version: number; docId: string; blocks: { id: string }[] } }, author: string, ops: Tx["ops"], txId: string) {
    this.send({ t: "tx", tx: { txId, docId: engine.state.docId, baseVersion: engine.state.version, author, ts: Date.now(), ops } });
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

test("协作者名单：邀请后 enforce 模式下可编辑，移除后降级只读", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const base = `http://127.0.0.1:${l.port}`;
  const owner = s.store.register("v7owner", "pass123");
  const other = s.store.register("v7member", "pass123");
  const doc = s.store.createDoc(owner.user.id, "协作者测试");
  const oc = await new C(l.port, doc.docId).open();
  const mc = await new C(l.port, doc.docId).open();
  try {
    // 开启 enforce：other 是 viewer
    s.store.setEnforceOwnerEdit(doc.docId, true);
    const oi = await oc.hello(owner.token);
    assert.equal((oi as { role?: string }).role, "owner");
    const mi1 = await mc.hello(other.token);
    assert.equal((mi1 as { role?: string }).role, "viewer");

    // 邀请（REST，仅 owner；不存在的用户名报错）
    const noauth = await fetch(`${base}/api/docs/${doc.docId}/collaborators`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${other.token}` },
      body: JSON.stringify({ username: "v7member" }),
    });
    assert.equal(noauth.status, 403);
    const bad = await fetch(`${base}/api/docs/${doc.docId}/collaborators`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ username: "不存在的人" }),
    });
    assert.equal(bad.status, 400);
    const ok1 = await fetch(`${base}/api/docs/${doc.docId}/collaborators`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ username: "v7member" }),
    });
    assert.equal(ok1.status, 200);
    const list = (await (await fetch(`${base}/api/docs/${doc.docId}/collaborators`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()) as {
      collaborators: { userId: string }[];
    };
    assert.equal(list.collaborators.length, 1);

    // 新连接：other 成为 editor
    const mc2 = await new C(l.port, doc.docId).open();
    const mi2 = await mc2.hello(other.token);
    assert.equal((mi2 as { role?: string }).role, "editor");

    // 移除 → 再连变 viewer；彻底删除文档时级联清理
    await fetch(`${base}/api/docs/${doc.docId}/collaborators/${other.user.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` } });
    const mc3 = await new C(l.port, doc.docId).open();
    const mi3 = await mc3.hello(other.token);
    assert.equal((mi3 as { role?: string }).role, "viewer");
    await mc2.close();
    await mc3.close();
  } finally {
    await oc.close();
    await mc.close();
    await l.close();
  }
});

test("image 块：合法 data URL 透传渲染，非法/超限被拒", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const owner = s.store.register("imgowner", "pass123");
  const doc = s.store.createDoc(owner.user.id, "图片测试");
  const engine = s.docs.get(doc.docId)!;
  const oc = await new C(l.port, doc.docId).open();
  try {
    await oc.hello(owner.token);
    const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    oc.tx(engine, owner.user.id, [{ type: "block.insert", id: "img1", afterId: null, text: "", blockType: "image", src: tinyPng }], "im1");
    await oc.waitFor((m) => m.t === "ack" && m.txId === "im1");
    const saved = engine.state.blocks.find((b) => b.id === "img1");
    assert.equal(saved?.type, "image");
    assert.equal(saved?.src, tinyPng);
    // 快照携带 src
    assert.equal(engine.snapshot().blocks.find((b) => b.id === "img1")?.src, tinyPng);
    // 非法 src（非 data:image）被 Hub 预检拒绝
    oc.tx(engine, owner.user.id, [{ type: "block.insert", id: "img2", afterId: null, text: "", blockType: "image", src: "http://evil.example/x.png" }], "im2");
    const nack2 = await oc.waitFor((m) => m.t === "nack" && m.txId === "im2");
    assert.ok(nack2.t === "nack" && nack2.reason === "INVALID");
    assert.equal(engine.state.blocks.find((b) => b.id === "img2"), undefined);
    // 超限图片被拒
    oc.tx(engine, owner.user.id, [{ type: "block.insert", id: "img3", afterId: null, text: "", blockType: "image", src: `data:image/png;base64,${"A".repeat(400_000)}` }], "im3");
    const nack = await oc.waitFor((m) => m.t === "nack" && m.txId === "im3");
    assert.ok(nack.t === "nack" && nack.reason === "INVALID");
  } finally {
    await oc.close();
    await l.close();
  }
});

test("性能护栏：千块文档的 doc.replace / 增量编辑 / 快照冒烟", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const owner = s.store.register("perfowner", "pass123");
  const doc = s.store.createDoc(owner.user.id, "千块冒烟");
  const engine = s.docs.get(doc.docId)!;
  const oc = await new C(l.port, doc.docId).open();
  try {
    await oc.hello(owner.token);
    // 2000 块 doc.replace（上限边界）
    const blocks = Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, type: "text" as const, text: `第 ${i} 行内容` }));
    oc.tx(engine, owner.user.id, [{ type: "doc.replace", blocks }], "big1");
    const t0 = Date.now();
    await oc.waitFor((m) => m.t === "ack" && m.txId === "big1", 10_000);
    const elapsed = Date.now() - t0;
    assert.equal(engine.state.blocks.length, 2000);
    // 增量编辑（尾部追加）
    const tail = engine.state.blocks[1999].text.length;
    oc.tx(engine, owner.user.id, [{ type: "text.insert", blockId: "p1999", offset: tail, text: "！" }], "inc1");
    await oc.waitFor((m) => m.t === "ack" && m.txId === "inc1");
    assert.ok(engine.state.blocks[1999].text.endsWith("！"));
    // 回读快照（走一次 snapshot 通道验证序列化）
    const snap = engine.snapshot();
    assert.equal(snap.blocks.length, 2000);
    // 记录耗时供人工观察（不做硬阈值断言，避免 CI 抖动）
    console.log(`[perf] 2000 块 doc.replace 提交往返 ${elapsed}ms`);
  } finally {
    await oc.close();
    await l.close();
  }
});
