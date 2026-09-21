/**
 * DocEngine 单元测试：应用正确性 / 幂等 / 块级 CAS / 作者豁免 / 锁 / 结构锚定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DocEngine, type DocState } from "../src/engine";
import type { Tx } from "../../shared/protocol";

function makeEngine(lockEnforced = false): DocEngine {
  const state: DocState = {
    docId: "t",
    version: 0,
    structureVersion: 0,
    blocks: [
      { id: "b1", type: "text", text: "hello", blockVersion: 0, lastWriter: "system" },
      { id: "b2", type: "text", text: "world", blockVersion: 0, lastWriter: "system" },
    ],
  };
  return new DocEngine(state, { lockEnforced });
}

function tx(e: DocEngine, author: string, ops: Tx["ops"], txId = `tx-${Math.random()}`, baseVersion?: number): Tx {
  return { txId, docId: "t", baseVersion: baseVersion ?? e.state.version, author, ts: Date.now(), ops };
}

test("文本 insert/delete 正确应用且版本 +1", () => {
  const e = makeEngine();
  const r = e.submit(tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 5, text: "!" }]));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.version, 1);
  assert.equal(e.state.blocks[0].text, "hello!");
  assert.equal(e.state.blocks[0].blockVersion, 1);
  assert.equal(e.state.blocks[0].lastWriter, "u1");

  const r2 = e.submit(tx(e, "u1", [{ type: "text.delete", blockId: "b1", offset: 5, length: 1 }]));
  assert.equal(r2.ok, true);
  assert.equal(e.state.blocks[0].text, "hello");
});

test("幂等：同一 txId 重复提交只执行一次", () => {
  const e = makeEngine();
  const t = tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "X" }], "dup-1");
  const r1 = e.submit(t);
  const r2 = e.submit({ ...t });
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.ok ? r1.version : 0, r2.ok ? r2.version : 1);
  assert.equal(e.state.version, 1);
  assert.equal(e.state.blocks[0].text, "Xhello");
});

test("块级 CAS：他人改过的块拒绝旧事务并返回权威文本", () => {
  const e = makeEngine();
  // u1 提交到 b1（版本 0→1）
  assert.ok(e.submit(tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "A" }])).ok);
  // u2 持有旧版本 0 的视图，对同一块提交 → CONFLICT
  const r = e.submit(
    tx(e, "u2", [{ type: "text.insert", blockId: "b1", offset: 0, text: "B" }], "tx-u2", 0),
  );
  assert.ok(!r.ok && r.reason === "CONFLICT");
  if (!r.ok && r.reason === "CONFLICT") {
    assert.deepEqual(r.blocks, [{ id: "b1", text: "Ahello" }]);
  }
  // 文档未被污染
  assert.equal(e.state.version, 1);
  assert.equal(e.state.blocks[0].text, "Ahello");
});

test("作者豁免：同一作者连续提交同一块不冲突", () => {
  const e = makeEngine();
  assert.ok(e.submit(tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "A" }])).ok);
  // u1 基于旧 base=0 的第二个事务（客户端尚未收到第一个 ack 的场景）
  const r = e.submit(
    tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 1, text: "B" }], "tx2", 0),
  );
  assert.ok(r.ok);
  assert.equal(e.state.blocks[0].text, "ABhello");
});

test("不同块并发不冲突（块级 CAS 的意义）", () => {
  const e = makeEngine();
  assert.ok(e.submit(tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "A" }])).ok);
  // u2 的旧视图（base=0）改另一个块 → 依然成功
  const r = e.submit(
    tx(e, "u2", [{ type: "text.insert", blockId: "b2", offset: 0, text: "B" }], "tx3", 0),
  );
  assert.ok(r.ok);
  assert.equal(e.state.blocks[0].text, "Ahello");
  assert.equal(e.state.blocks[1].text, "Bworld");
});

test("block.insert 用 afterId 锚定插入；afterId 缺失时退化为追加末尾", () => {
  const e = makeEngine();
  const r = e.submit(tx(e, "u1", [{ type: "block.insert", id: "n1", afterId: "b1", text: "middle" }]));
  assert.ok(r.ok);
  assert.deepEqual(
    e.state.blocks.map((b) => b.id),
    ["b1", "n1", "b2"],
  );
  // 结构并发：他人删掉锚点后，插入退化为末尾追加而非失败
  assert.ok(e.submit(tx(e, "u2", [{ type: "block.delete", id: "b1" }])).ok);
  const r2 = e.submit(
    tx(e, "u1", [{ type: "block.insert", id: "n2", afterId: "b1", text: "tail" }], "tx9", 1),
  );
  assert.ok(r2.ok);
  assert.deepEqual(
    e.state.blocks.map((b) => b.id),
    ["n1", "b2", "n2"],
  );
});

test("block.insert 幂等：同 id 重复插入跳过", () => {
  const e = makeEngine();
  const t = tx(e, "u1", [{ type: "block.insert", id: "n1", afterId: null, text: "x" }], "dup-b");
  assert.ok(e.submit(t).ok);
  assert.ok(e.submit({ ...t }).ok);
  assert.equal(e.state.blocks.filter((b) => b.id === "n1").length, 1);
});

test("block.delete 目标已被他人删除 → 该 op 退化为 no-op，事务其余 op 正常", () => {
  const e = makeEngine();
  assert.ok(e.submit(tx(e, "u1", [{ type: "block.delete", id: "b1" }])).ok); // v1: b1 删除
  // u2（旧视图）删除 b1 同时给 b2 插入文本
  const r = e.submit(
    tx(e, "u2", [
      { type: "block.delete", id: "b1" },
      { type: "text.insert", blockId: "b2", offset: 0, text: "Z" },
    ], "tx-mix", 0),
  );
  assert.ok(r.ok);
  assert.equal(e.state.blocks.length, 1);
  assert.equal(e.state.blocks[0].text, "Zworld");
});

test("强制锁：他人持锁的块被拒绝 LOCKED", () => {
  const e = makeEngine(true);
  e.setLockChecker((blockId, userId) => blockId === "b1" && userId !== "u1");
  const r = e.submit(tx(e, "u2", [{ type: "text.insert", blockId: "b1", offset: 0, text: "X" }]));
  assert.ok(!r.ok && r.reason === "LOCKED");
  assert.equal(e.state.blocks[0].text, "hello");
  // 持锁者本人不受影响
  assert.ok(e.submit(tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "X" }])).ok);
});

test("baseVersion 超前 → INVALID", () => {
  const e = makeEngine();
  const r = e.submit(
    tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "X" }], "tx-bad", 99),
  );
  assert.ok(!r.ok && r.reason === "INVALID");
});

test("事务原子性：一半成功一半失败的 tx 整体不生效", () => {
  const e = makeEngine();
  assert.ok(e.submit(tx(e, "u1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "A" }])).ok);
  // u2 旧视图：改 b2（可过 CAS）+ 改 b1（会被 CAS 拒绝）→ 整体失败，b2 不留半截
  const r = e.submit(
    tx(e, "u2", [
      { type: "text.insert", blockId: "b2", offset: 0, text: "B" },
      { type: "text.insert", blockId: "b1", offset: 0, text: "C" },
    ], "tx-atomic", 0),
  );
  assert.ok(!r.ok);
  assert.equal(e.state.blocks[1].text, "world");
  assert.equal(e.state.version, 1);
});

test("block.insert 支持块类型与勾选态；snapshot 携带", () => {
  const e = makeEngine();
  const r = e.submit(
    tx(e, "u1", [{ type: "block.insert", id: "n1", afterId: null, text: "任务", blockType: "todo", checked: true }]),
  );
  assert.ok(r.ok);
  const nb = e.state.blocks.find((b) => b.id === "n1")!;
  assert.equal(nb.type, "todo");
  assert.equal(nb.checked, true);
  const snap = e.snapshot();
  assert.equal(snap.blocks.find((b) => b.id === "n1")?.checked, true);
});

test("block.update：修改类型/勾选，参与块级 CAS", () => {
  const e = makeEngine();
  // u1 把 b1 改为 h1（v1）
  assert.ok(
    e.submit(tx(e, "u1", [{ type: "block.update", id: "b1", blockType: "h1", prevBlockType: "text" }])).ok,
  );
  assert.equal(e.state.blocks[0].type, "h1");
  assert.equal(e.state.blocks[0].blockVersion, 1);
  // 同作者豁免：u1 基于旧 base=0 再改勾选 → 允许
  assert.ok(
    e.submit(tx(e, "u1", [{ type: "block.update", id: "b1", checked: true, prevChecked: false }], "t2", 0)).ok,
  );
  assert.equal(e.state.blocks[0].checked, true);
  // 他人基于旧视图改同一块 → CONFLICT
  const r = e.submit(
    tx(e, "u2", [{ type: "block.update", id: "b1", blockType: "text", prevBlockType: "h1" }], "t3", 0),
  );
  assert.ok(!r.ok && r.reason === "CONFLICT");
  // 目标块不存在 → CONFLICT
  const r2 = e.submit(tx(e, "u2", [{ type: "block.update", id: "missing", blockType: "h2" }]));
  assert.ok(!r2.ok && r2.reason === "CONFLICT");
});


test("block.move：重排生效、幂等重放、锚点缺失退化为末尾", () => {
  const e = makeEngine();
  const mk = (ids: string[]) => e.submit(tx(e, "u1", ids.map((id, i) => ({ type: "block.insert" as const, id, afterId: i === 0 ? null : ids[i - 1], text: id })), `ins-${ids.join("")}`));
  mk(["a", "b", "c"]);
  assert.deepEqual(e.state.blocks.map((b) => b.id), ["b1", "b2", "a", "b", "c"]);
  // c 移到最前（beforeId=首块）
  const r = e.submit(tx(e, "u1", [{ type: "block.move", id: "c", beforeId: "b1", undoBeforeId: null }]));
  assert.ok(r.ok);
  assert.deepEqual(e.state.blocks.map((b) => b.id), ["c", "b1", "b2", "a", "b"]);
  // 幂等重放：同 txId 不再变化
  const r2 = e.submit(tx(e, "u1", [{ type: "block.move", id: "c", beforeId: "b1", undoBeforeId: null }]));
  assert.ok(r2.ok);
  assert.deepEqual(e.state.blocks.map((b) => b.id), ["c", "b1", "b2", "a", "b"]);
  // 锚点缺失 → 退化为末尾
  e.submit(tx(e, "u1", [{ type: "block.move", id: "a", beforeId: "ghost" }]));
  assert.deepEqual(e.state.blocks.map((b) => b.id), ["c", "b1", "b2", "b", "a"]);
  // beforeId=null → 末尾
  e.submit(tx(e, "u1", [{ type: "block.move", id: "c", beforeId: null }]));
  assert.deepEqual(e.state.blocks.map((b) => b.id), ["b1", "b2", "b", "a", "c"]);
  // 目标块不存在 → no-op
  const r3 = e.submit(tx(e, "u1", [{ type: "block.move", id: "ghost", beforeId: null }]));
  assert.ok(r3.ok);
  assert.equal(e.state.blocks.length, 5);
});