/**
 * 认证与存储测试：注册/登录/登出/改名、用户名唯一（大小写不敏感）、SQLite 读写。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { buildServer } from "../src/index";
import { Store, StoreError } from "../src/store";

function tmpDb() {
  return path.join(os.tmpdir(), `collab-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test("注册：用户名唯一（大小写不敏感）；重复注册明确报错", () => {
  const store = new Store(tmpDb());
  try {
    const r1 = store.register("alice", "pass123");
    assert.equal(r1.user.username, "alice");
    assert.ok(r1.token.length > 20);
    // 大小写不同仍视为重复
    assert.throws(() => store.register("Alice", "pass456"), StoreError);
    assert.throws(() => store.register("ALICE", "pass456"), /已被占用/);
    // 用户名格式校验
    assert.throws(() => store.register("a", "pass123"), /长度/);
    assert.throws(() => store.register("bad name", "pass123"), /空白/);
    assert.throws(() => store.register("okname", "12"), /密码/);
  } finally {
    store.close();
  }
});

test("登录：正确密码成功且获得会话 token；错误密码拒绝", () => {
  const store = new Store(tmpDb());
  try {
    store.register("alice", "pass123");
    const ok = store.login("alice", "pass123");
    assert.equal(ok.user.username, "alice");
    assert.throws(() => store.login("alice", "wrong!"), /用户名或密码错误/);
    assert.throws(() => store.login("nobody", "pass123"), /用户名或密码错误/);
    // token 可反查身份；登出后失效
    const who = store.resolveToken(ok.token);
    assert.equal(who?.id, ok.user.id);
    store.logout(ok.token);
    assert.equal(store.resolveToken(ok.token), null);
  } finally {
    store.close();
  }
});

test("改名：全局唯一校验；改名后 token 身份同步更新", () => {
  const store = new Store(tmpDb());
  try {
    const a = store.register("alice", "pass123");
    store.register("bob", "pass123");
    assert.throws(() => store.rename(a.user.id, "Bob"), /已被占用/);
    const renamed = store.rename(a.user.id, "alice2");
    assert.equal(renamed.username, "alice2");
    assert.equal(store.resolveToken(a.token)?.username, "alice2");
  } finally {
    store.close();
  }
});

test("访客：自动分配唯一用户名；token 身份可继承", () => {
  const store = new Store(tmpDb());
  try {
    const g1 = store.createGuest("小明");
    assert.equal(g1.user.username, "小明");
    assert.equal(g1.user.isGuest, true);
    // 同名访客再次创建 → 自动换名
    const g2 = store.createGuest("小明");
    assert.notEqual(g2.user.username, "小明");
    // token 继承
    const who = store.resolveToken(g1.token);
    assert.equal(who?.id, g1.user.id);
  } finally {
    store.close();
  }
});

test("SQLite 文档：每次提交即落盘；重启后状态一致", async () => {
  const dbPath = tmpDb();
  {
    const srv = buildServer(dbPath);
    const l = await srv.listen(0);
    const block = srv.engine.state.blocks[0];
    srv.engine.submit({
      txId: "persist-1",
      docId: srv.engine.state.docId,
      baseVersion: 0,
      author: "u1",
      ts: Date.now(),
      ops: [{ type: "text.insert", blockId: block.id, offset: 0, text: "持久化!" }],
    });
    await l.close();
  }
  {
    const srv2 = buildServer(dbPath);
    const l2 = await srv2.listen(0);
    assert.equal(srv2.engine.state.version, 1);
    assert.ok(srv2.engine.state.blocks[0].text.startsWith("持久化!"));
    await l2.close();
  }
});

test("HTTP 认证路由：注册/登录/重复注册/改名（含 presence 无异常）", async () => {
  const srv = buildServer(tmpDb()); const l = await srv.listen(0);
  const base = `http://127.0.0.1:${l.port}`;
  try {
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "secret" }),
    });
    assert.equal(reg.status, 200);
    const regData = (await reg.json()) as { token: string; user: { username: string } };
    assert.equal(regData.user.username, "carol");

    const dup = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "CAROL", password: "secret" }),
    });
    assert.equal(dup.status, 400);
    assert.match(((await dup.json()) as { error: string }).error, /已被占用/);

    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "carol", password: "nope" }),
    });
    assert.equal(bad.status, 400);

    const rename = await fetch(`${base}/api/auth/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: regData.token, name: "carol-renamed" }),
    });
    assert.equal(rename.status, 200);
    assert.equal(((await rename.json()) as { user: { username: string } }).user.username, "carol-renamed");

    const health = await fetch(`${base}/api/health`);
    assert.equal((await health.json()).ok, true);
  } finally {
    await l.close();
  }
});
