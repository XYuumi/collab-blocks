/**
 * WS 协议集成测试：在真实 WebSocket 上验证多客户端协同的关键场景。
 * 覆盖：token 身份 / 并发不同块 / 幂等重发 / 同块冲突 / 强制锁 / 重连对账 / Origin 拦截。
 */
import test from "node:test";
import { DOC_ID } from "../../shared/protocol";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { buildServer } from "../src/index";
import type { ClientMsg, ServerMsg, Tx } from "../../shared/protocol";

interface TestServer {
  engine: import("../src/engine").DocEngine;
  store: import("../src/store").Store;
  port: number;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const dbPath = path.join(os.tmpdir(), `collab-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const s = buildServer(dbPath);
  const l = await s.listen(0);
  return { engine: s.engine, store: s.store, port: l.port, close: l.close };
}

class TestClient {
  ws: WebSocket;
  received: ServerMsg[] = [];

  constructor(port: number, extraHeaders?: Record<string, string>) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: extraHeaders });
    this.ws.on("message", (d) => {
      this.received.push(JSON.parse(String(d)));
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
  }

  send(msg: ClientMsg) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(pred: (m: ServerMsg) => boolean, timeout = 3000): Promise<ServerMsg> {
    const found = this.received.find(pred);
    if (found) return found;
    return new Promise<ServerMsg>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("waitFor timeout")), timeout);
      const onMsg = () => {
        const m = this.received.find(pred);
        if (m) {
          clearTimeout(timer);
          this.ws.off("message", onMsg);
          res(m);
        }
      };
      this.ws.on("message", onMsg);
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

function makeTx(engine: TestServer["engine"], author: string, ops: Tx["ops"], txId: string, baseVersion?: number): Tx {
  return { txId, docId: engine.state.docId, baseVersion: baseVersion ?? engine.state.version, author, ts: Date.now(), ops };
}

test("token 身份：hello 携带注册 token 继承用户；无 token 成为访客", async () => {
  const srv = await startServer();
  const a = new TestClient(srv.port);
  const b = new TestClient(srv.port);
  try {
    const alice = srv.store.register("alice", "pass123");
    await a.open();
    await b.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    b.send({ t: "hello", docId: DOC_ID });
    const initA = await a.waitFor((m) => m.t === "init");
    const initB = await b.waitFor((m) => m.t === "init");
    assert.ok(initA.t === "init" && initA.you.name === "alice" && initA.you.isGuest === false);
    assert.ok(initB.t === "init" && initB.you.isGuest === true);
    assert.ok(initB.t === "init" && initB.you.name.startsWith("访客-"));
    await a.waitFor((m) => m.t === "presence" && m.users.length === 2);
  } finally {
    await a.close();
    await b.close();
    await srv.close();
  }
});

test("双客户端并发编辑不同块均成功且互相可见", async () => {
  const srv = await startServer();
  const alice = srv.store.register("alice", "pass123");
  const bob = srv.store.register("bob", "pass123");
  const a = new TestClient(srv.port);
  const b = new TestClient(srv.port);
  try {
    await a.open();
    await b.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    b.send({ t: "hello", docId: DOC_ID, token: bob.token });
    await a.waitFor((m) => m.t === "init");
    await b.waitFor((m) => m.t === "init");

    const b1 = srv.engine.state.blocks[0];
    const b2 = srv.engine.state.blocks[1];
    a.send({
      t: "tx",
      tx: makeTx(srv.engine, alice.user.id, [{ type: "text.insert", blockId: b1.id, offset: b1.text.length, text: " A" }], "t1", 0),
    });
    b.send({
      t: "tx",
      tx: makeTx(srv.engine, bob.user.id, [{ type: "text.insert", blockId: b2.id, offset: 0, text: "B " }], "t2", 0),
    });

    await a.waitFor((m) => m.t === "ack" && m.txId === "t1");
    await b.waitFor((m) => m.t === "ack" && m.txId === "t2");
    await a.waitFor((m) => m.t === "remote.op" && m.tx.txId === "t2");
    await b.waitFor((m) => m.t === "remote.op" && m.tx.txId === "t1");
    assert.equal(srv.engine.state.blocks[0].text, `${b1.text} A`);
    assert.equal(srv.engine.state.blocks[1].text, `B ${b2.text}`);
  } finally {
    await a.close();
    await b.close();
    await srv.close();
  }
});

test("重复发送同一 Tx（超时重发模拟）：只执行一次，重发返回相同 ACK", async () => {
  const srv = await startServer();
  const alice = srv.store.register("alice", "pass123");
  const a = new TestClient(srv.port);
  try {
    await a.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    await a.waitFor((m) => m.t === "init");
    const block = srv.engine.state.blocks[0];
    const t = makeTx(srv.engine, alice.user.id, [{ type: "text.insert", blockId: block.id, offset: 0, text: "X" }], "dup");
    a.send({ t: "tx", tx: t });
    const ack1 = await a.waitFor((m) => m.t === "ack" && m.txId === "dup");
    a.send({ t: "tx", tx: t }); // 网络层面重发
    const ack2 = await a.waitFor((m) => m.t === "ack" && m.txId === "dup");
    const v1 = ack1.t === "ack" ? ack1.version : -1;
    const v2 = ack2.t === "ack" ? ack2.version : -2;
    assert.equal(v1, v2);
    assert.equal(srv.engine.state.version, 1);
  } finally {
    await a.close();
    await srv.close();
  }
});

test("同块并发：后到者收到 CONFLICT nack 且附带权威文本", async () => {
  const srv = await startServer();
  const alice = srv.store.register("alice", "pass123");
  const bob = srv.store.register("bob", "pass123");
  const a = new TestClient(srv.port);
  const b = new TestClient(srv.port);
  try {
    await a.open();
    await b.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    b.send({ t: "hello", docId: DOC_ID, token: bob.token });
    await a.waitFor((m) => m.t === "init");
    await b.waitFor((m) => m.t === "init");

    const block = srv.engine.state.blocks[0];
    a.send({ t: "tx", tx: makeTx(srv.engine, alice.user.id, [{ type: "text.insert", blockId: block.id, offset: 0, text: "A" }], "a1", 0) });
    await a.waitFor((m) => m.t === "ack");
    b.send({ t: "tx", tx: makeTx(srv.engine, bob.user.id, [{ type: "text.insert", blockId: block.id, offset: 0, text: "B" }], "b1", 0) });
    const nack = await b.waitFor((m) => m.t === "nack" && m.txId === "b1");
    assert.ok(nack.t === "nack" && nack.reason === "CONFLICT");
    if (nack.t === "nack" && nack.blocks) {
      assert.deepEqual(nack.blocks, [{ id: block.id, text: `A${block.text}` }]);
    }
  } finally {
    await a.close();
    await b.close();
    await srv.close();
  }
});

test("强制块锁：他人持锁块的写入被拒 LOCKED，持锁者本人可用", async () => {
  const srv = await startServer();
  const alice = srv.store.register("alice", "pass123");
  const bob = srv.store.register("bob", "pass123");
  const a = new TestClient(srv.port);
  const b = new TestClient(srv.port);
  try {
    await a.open();
    await b.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    b.send({ t: "hello", docId: DOC_ID, token: bob.token });
    await a.waitFor((m) => m.t === "init");
    await b.waitFor((m) => m.t === "init");

    const block = srv.engine.state.blocks[0];
    a.send({ t: "config", lockEnforced: true });
    await a.waitFor((m) => m.t === "config.changed" && m.config.lockEnforced);
    a.send({ t: "lock.acquire", blockId: block.id });
    await b.waitFor((m) => m.t === "lock.changed" && m.lock !== null);

    b.send({ t: "tx", tx: makeTx(srv.engine, bob.user.id, [{ type: "text.insert", blockId: block.id, offset: 0, text: "B" }], "bx") });
    const nack = await b.waitFor((m) => m.t === "nack" && m.txId === "bx");
    assert.ok(nack.t === "nack" && nack.reason === "LOCKED");

    a.send({ t: "tx", tx: makeTx(srv.engine, alice.user.id, [{ type: "text.insert", blockId: block.id, offset: 0, text: "A" }], "ax") });
    await a.waitFor((m) => m.t === "ack" && m.txId === "ax");
  } finally {
    await a.close();
    await b.close();
    await srv.close();
  }
});

test("重连对账：sync 返回快照，并告知 pending 中已执行的 Tx", async () => {
  const srv = await startServer();
  const alice = srv.store.register("alice", "pass123");
  const a = new TestClient(srv.port);
  try {
    await a.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    await a.waitFor((m) => m.t === "init");
    const block = srv.engine.state.blocks[0];

    a.send({ t: "tx", tx: makeTx(srv.engine, alice.user.id, [{ type: "text.insert", blockId: block.id, offset: 0, text: "X" }], "t1", 0) });
    await a.waitFor((m) => m.t === "ack" && m.txId === "t1");

    a.send({ t: "sync", haveVersion: 0, pendingTxIds: ["t1", "t9"] });
    const snap = await a.waitFor((m) => m.t === "snapshot");
    assert.ok(snap.t === "snapshot");
    assert.deepEqual(snap.t === "snapshot" ? snap.ackedTxIds : [], ["t1"]);
    assert.ok(snap.t === "snapshot" && snap.doc.version >= 1);
  } finally {
    await a.close();
    await srv.close();
  }
});

test("安全：伪造 Origin 的 WebSocket 连接被拒绝", async () => {
  const srv = await startServer();
  try {
    const evil = new TestClient(srv.port, { origin: "http://evil.example" });
    const closed = new Promise<void>((res) => evil.ws.once("close", res));
    await evil.open();
    await closed; // 服务器应立即关闭
    evil.send({ t: "hello", docId: DOC_ID });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(evil.received.filter((m) => m.t === "init").length, 0);
  } finally {
    await srv.close();
  }
});

test("安全：超大事务被拒绝（ops 数量上限）", async () => {
  const srv = await startServer();
  const alice = srv.store.register("alice", "pass123");
  const a = new TestClient(srv.port);
  try {
    await a.open();
    a.send({ t: "hello", docId: DOC_ID, token: alice.token });
    await a.waitFor((m) => m.t === "init");
    const block = srv.engine.state.blocks[0];
    const ops = Array.from({ length: 300 }, (_, i) => ({
      type: "text.insert" as const,
      blockId: block.id,
      offset: i,
      text: "x",
    }));
    a.send({ t: "tx", tx: makeTx(srv.engine, alice.user.id, ops, "big") });
    const nack = await a.waitFor((m) => m.t === "nack" && m.txId === "big");
    assert.ok(nack.t === "nack" && nack.reason === "INVALID");
  } finally {
    await a.close();
    await srv.close();
  }
});
