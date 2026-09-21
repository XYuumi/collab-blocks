/**
 * v5 功能测试：块级评论（REST + WS 广播 + 权限）与回收站（软删除/恢复/彻底删除）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { buildServer } from "../src/index";
import type { ServerMsg } from "../../shared/protocol";

function tmpDb() {
  return path.join(os.tmpdir(), `collab-feat-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

test("块级评论：添加/列表/解决 + WS 实时广播（含发送者）", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const base = `http://127.0.0.1:${l.port}`;
  const owner = s.store.register("cowner", "pass123");
  const doc = s.store.createDoc(owner.user.id, "评论测试");
  const block = s.docs.get(doc.docId)!.state.blocks[0].id;
  const wsClient = await new C(l.port, doc.docId).open();
  try {
    await wsClient.hello(owner.token);
    // 未登录不可
    const noauth = await fetch(`${base}/api/docs/${doc.docId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: block, body: "x" }) });
    assert.equal(noauth.status, 401);
    // 添加（访客 token 也可以）
    const guest = s.store.createGuest();
    const r1 = await fetch(`${base}/api/docs/${doc.docId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${guest.token}` },
      body: JSON.stringify({ blockId: block, body: "第一条评论" }),
    });
    assert.equal(r1.status, 200);
    const c1 = (await r1.json()) as { comment: { id: number } };
    // WS 收到广播
    const pushed = await wsClient.waitFor((m) => m.t === "comment.added");
    assert.ok(pushed.t === "comment.added" && pushed.comment.body === "第一条评论");
    // 列表
    const list = (await (await fetch(`${base}/api/docs/${doc.docId}/comments`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()) as { comments: { id: number; resolved: boolean }[] };
    assert.equal(list.comments.length, 1);
    // 解决
    const res2 = await fetch(`${base}/api/docs/${doc.docId}/comments/${c1.comment.id}/resolve`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(res2.status, 200);
    assert.equal(((await res2.json()) as { resolved: boolean }).resolved, true);
    // 目标块不存在 → 400
    const bad = await fetch(`${base}/api/docs/${doc.docId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ blockId: "ghost", body: "x" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await wsClient.close();
    await l.close();
  }
});

test("评论权限：enforceOwnerEdit 开启后非创建者 403", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const base = `http://127.0.0.1:${l.port}`;
  const owner = s.store.register("eowner", "pass123");
  const other = s.store.register("eother", "pass123");
  const doc = s.store.createDoc(owner.user.id, "权限评论");
  const block = s.docs.get(doc.docId)!.state.blocks[0].id;
  try {
    s.store.setEnforceOwnerEdit(doc.docId, true);
    const denied = await fetch(`${base}/api/docs/${doc.docId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${other.token}` },
      body: JSON.stringify({ blockId: block, body: "x" }),
    });
    assert.equal(denied.status, 403);
    const ok = await fetch(`${base}/api/docs/${doc.docId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ blockId: block, body: "owner 可以" }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await l.close();
  }
});

test("回收站：软删除（列表不可见/引擎不可载）→ 恢复可见；彻底删除清除数据", async () => {
  const s = buildServer(tmpDb());
  const l = await s.listen(0);
  const base = `http://127.0.0.1:${l.port}`;
  const owner = s.store.register("towner", "pass123");
  const doc = s.store.createDoc(owner.user.id, "回收站测试");
  try {
    // 软删除
    const del = await fetch(`${base}/api/docs/${doc.docId}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(del.status, 200);
    const list = (await (await fetch(`${base}/api/docs`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()) as { docs: { docId: string }[] };
    assert.equal(list.docs.some((d) => d.docId === doc.docId), false);
    // 引擎不可再载（hello 会拒绝）
    const c = await new C(l.port, doc.docId).open();
    c.ws.send(JSON.stringify({ t: "hello", docId: doc.docId, token: owner.token }));
    await c.waitFor((m) => m.t === "error");
    await c.close();
    // 回收站列表 + 恢复
    const trash = (await (await fetch(`${base}/api/docs/trash/list`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()) as { docs: { docId: string }[] };
    assert.equal(trash.docs.some((d) => d.docId === doc.docId), true);
    const restore = await fetch(`${base}/api/docs/${doc.docId}/restore`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(restore.status, 200);
    const list2 = (await (await fetch(`${base}/api/docs`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()) as { docs: { docId: string }[] };
    assert.equal(list2.docs.some((d) => d.docId === doc.docId), true);
    // 再删 → 彻底删除
    await fetch(`${base}/api/docs/${doc.docId}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` } });
    const purge = await fetch(`${base}/api/docs/${doc.docId}/purge`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(purge.status, 200);
    assert.equal(s.store.getTrashRow(doc.docId), null);
    // 其他人不能恢复/清除
    const other = s.store.register("tother", "pass123");
    const doc2 = s.store.createDoc(owner.user.id, "第二个");
    await fetch(`${base}/api/docs/${doc2.docId}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` } });
    const denied = await fetch(`${base}/api/docs/${doc2.docId}/restore`, { method: "POST", headers: { Authorization: `Bearer ${other.token}` } });
    assert.equal(denied.status, 403);
  } finally {
    await l.close();
  }
});
