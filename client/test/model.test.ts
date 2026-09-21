/**
 * DocModel 双模型收敛测试（纯逻辑，不依赖 DOM）。
 *
 * 模拟两个客户端 m1/m2 与服务器引擎的完整交互，验证：
 * 1. 不同块并发 → 双方提交均成功且收敛；
 * 2. 同块并发（在途事务撞上他人提交）→ CONFLICT → rebuild（回滚+微型变换+重放）→ 重发 → 收敛且双方输入都保留；
 * 3. 远程 op 到达时本地有 pending → 变换后可见文本即最终收敛文本；
 * 4. 断线重连对账（snapshot + ackedTxIds）后 pending 重放收敛，ACK 丢失的事务不重复应用；
 * 5. 结构并发：他人删除我的锚点块 → pending 块重锚 + 可见位置归一化，两端块序一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DocModel } from "../src/model";
import { DocEngine, type DocState } from "../../server/src/engine";
import type { Op, Tx } from "@shared/protocol";

function seed(): DocState {
  return {
    docId: "t",
    version: 0,
    structureVersion: 0,
    blocks: [
      { id: "b1", type: "text", text: "hello", blockVersion: 0, lastWriter: "system" },
      { id: "b2", type: "text", text: "world", blockVersion: 0, lastWriter: "system" },
    ],
  };
}

interface Client {
  m: DocModel;
  id: string;
}

function client(engine: DocEngine, userId: string): Client {
  const m = new DocModel();
  m.loadSnapshot(engine.snapshot());
  return { m, id: userId };
}

/** 把 c 的 pending 以其当前版本为基线打包成待发送 Tx（同 TxQueue.resubmitAll 语义） */
function packagePending(c: Client): Tx[] {
  return c.m.pending.map((p) => ({
    txId: p.txId,
    docId: "t",
    baseVersion: c.m.version,
    author: c.id,
    ts: Date.now(),
    ops: [...p.ops],
  }));
}

/** 模拟"客户端提交 → 服务器仲裁 → 广播/回执"的完整回合 */
function exchange(sender: Client, engine: DocEngine, others: Client[], txs?: Tx[]) {
  const list = txs ?? packagePending(sender);
  const results: { tx: Tx; ok: boolean; reason?: string }[] = [];
  for (const tx of list) {
    const r = engine.submit(tx);
    results.push({ tx, ok: r.ok, reason: r.ok ? undefined : r.reason });
    if (r.ok) {
      sender.m.onAck(tx.txId, r.version);
      for (const o of others) o.m.onRemoteOp(tx, r.version);
    } else if (r.reason === "CONFLICT") {
      sender.m.rebuild(r.blocks, undefined);
    } else {
      throw new Error("unexpected nack: " + r.reason);
    }
  }
  return results;
}

test("不同块并发编辑：双方提交均成功且三方收敛", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");
  c1.m.applyLocal("t1", [{ type: "text.insert", blockId: "b1", offset: 5, text: " 1" }]);
  c2.m.applyLocal("t2", [{ type: "text.insert", blockId: "b2", offset: 0, text: "2 " }]);
  exchange(c1, engine, [c2]);
  exchange(c2, engine, [c1]);
  for (const c of [c1, c2]) {
    assert.equal(c.m.visibleText("b1"), "hello 1");
    assert.equal(c.m.visibleText("b2"), "2 world");
  }
  assert.equal(engine.state.blocks[0].text, "hello 1");
  assert.equal(engine.state.blocks[1].text, "2 world");
});

test("同块并发：在途 Tx 被拒 → rebuild 合并（微型变换）→ 重发 → 收敛且双方输入都保留", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");

  // 双方基于 v0 同时在 b1 开头插入，c2 的 Tx 已发出（在途，内容为原始 ops）
  c2.m.applyLocal("c2-tx", [{ type: "text.insert", blockId: "b1", offset: 0, text: "B" }]);
  const inflight: Tx = {
    txId: "c2-tx",
    docId: "t",
    baseVersion: 0,
    author: "u2",
    ts: 0,
    ops: [{ type: "text.insert", blockId: "b1", offset: 0, text: "B" }],
  };

  // c1 先提交成功（v1），并广播到 c2 → c2 的 pending 被变换为 offset+1
  c1.m.applyLocal("t1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "A" }]);
  exchange(c1, engine, [c2]);

  // 服务器此刻才评估 c2 的在途 Tx（原始 ops + 旧 base）→ CONFLICT
  const r = engine.submit(inflight);
  assert.ok(!r.ok && r.reason === "CONFLICT");
  if (!r.ok && r.reason === "CONFLICT") assert.deepEqual(r.blocks, [{ id: "b1", text: "Ahello" }]);

  // c2 收到 nack → rebuild（回滚→重放，此时 ops 已是变换后的）→ 重发（同 txId）
  c2.m.rebuild([{ id: "b1", text: "Ahello" }], undefined);
  const resent = exchange(c2, engine, [c1]);
  assert.equal(resent.every((x) => x.ok), true);

  // 三方收敛，A、B 都保留（同位置并发插入的确定性平局规则：后提交者排在前者之后）
  const finalText = engine.state.blocks[0].text;
  assert.equal(finalText, c1.m.visibleText("b1"));
  assert.equal(finalText, c2.m.visibleText("b1"));
  assert.equal(finalText, "ABhello");
});

test("远程 op 与本地 pending 同块交织：变换后可见文本即最终收敛文本", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");

  // c2 旧视图（v0）上产生 pending：打算在 hello 后加 "!"
  c2.m.applyLocal("z1", [{ type: "text.insert", blockId: "b1", offset: 5, text: "!" }]);
  // c1 连续提交两笔（v1: 前插 X, v2: X 后插 Y），按序广播到 c2
  c1.m.applyLocal("x1", [{ type: "text.insert", blockId: "b1", offset: 0, text: "X" }]);
  exchange(c1, engine, [c2]);
  c1.m.applyLocal("x2", [{ type: "text.insert", blockId: "b1", offset: 1, text: "Y" }]);
  exchange(c1, engine, [c2]);

  // c2 的 insert(5,"!") 被平移为 offset=7
  assert.equal(c2.m.visibleText("b1"), "XYhello!");
  // c2 提交（其 baseVersion 已随远程 op 前进，ops 已变换）→ 直接成功并收敛
  const res = exchange(c2, engine, [c1]);
  assert.equal(res.every((x) => x.ok), true);
  assert.equal(engine.state.blocks[0].text, "XYhello!");
  assert.equal(c1.m.visibleText("b1"), "XYhello!");
  assert.equal(c2.m.visibleText("b1"), "XYhello!");
});

test("断线重连对账：ACK 丢失的事务不重复应用，未确认的重放补发", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  // c1 的 tx "lost" 服务器已执行，但 ACK 在断线中丢失
  c1.m.applyLocal("lost", [{ type: "text.insert", blockId: "b1", offset: 0, text: "L" }]);
  const r = engine.submit({
    txId: "lost",
    docId: "t",
    baseVersion: 0,
    author: "u1",
    ts: 0,
    ops: [...c1.m.pendingFor("lost")],
  });
  assert.ok(r.ok);
  // 断线期间又编辑了一笔
  c1.m.applyLocal("after", [{ type: "text.insert", blockId: "b2", offset: 0, text: "M" }]);
  // 重连对账：服务器告知 lost 已执行
  c1.m.onSnapshotResync(engine.snapshot(), ["lost"]);
  assert.equal(c1.m.pendingIds().includes("lost"), false);
  assert.equal(c1.m.pendingIds().includes("after"), true);
  assert.equal(c1.m.visibleText("b1"), "Lhello"); // 快照重建后可见（未被重复应用）
  assert.equal(c1.m.visibleText("b2"), "Mworld");
  // 补发 after → 收敛
  exchange(c1, engine, []);
  assert.equal(engine.state.blocks[1].text, "Mworld");
});

test("结构并发：他人删除我的锚点块 → pending 块重锚且两端块序一致", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");
  // c2 计划在 b1（首块）后插新块（本地已乐观可见于最前）
  c2.m.applyLocal("ins", [{ type: "block.insert", id: "n1", afterId: "b1", text: "new" }]);
  assert.equal(c2.m.blocks.map((b) => b.id).join(","), "b1,n1,b2");
  // c1 删除 b1（v1）并广播
  c1.m.applyLocal("del", [{ type: "block.delete", id: "b1", text: "hello", prevId: null }]);
  exchange(c1, engine, [c2]);
  // c2 的锚点没了 → 重锚为末尾（与服务器宽松语义一致），可见位置归一化
  assert.equal(c2.m.blocks.map((b) => b.id).join(","), "b2,n1");
  // c2 补发后服务器应用，三方一致
  const res = exchange(c2, engine, [c1]);
  assert.equal(res.every((x) => x.ok), true);
  assert.equal(engine.state.blocks.map((b) => b.id).join(","), "b2,n1");
  assert.equal(c1.m.blocks.map((b) => b.id).join(","), "b2,n1");
  assert.equal(c2.m.blocks.map((b) => b.id).join(","), "b2,n1");
});

test("block.update（块类型/勾选）的双端同步与撤销收敛", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");
  // c1 把 b1 改为 todo 并勾选（两笔事务）
  c1.m.applyLocal("u1", [{ type: "block.update", id: "b1", blockType: "todo", prevBlockType: "text" }]);
  exchange(c1, engine, [c2]);
  c1.m.applyLocal("u2", [{ type: "block.update", id: "b1", checked: true, prevChecked: false }]);
  exchange(c1, engine, [c2]);
  assert.equal(c2.m.block("b1")?.type, "todo");
  assert.equal(c2.m.block("b1")?.checked, true);

  // 撤销勾选：逆操作 block.update {checked:false}
  c1.m.applyLocal("u3", [{ type: "block.update", id: "b1", checked: false, prevChecked: true }]);
  exchange(c1, engine, [c2]);
  assert.equal(engine.state.blocks[0].checked, false);
  assert.equal(c1.m.block("b1")?.checked, false);
  assert.equal(c2.m.block("b1")?.checked, false);

  // 他人并发改类型 → 后到者 CAS 拒绝 → rebuild（回到服务器状态）→ 重放重试 → 以新基线生效
  // （属性类操作无可变换的偏移，重放即"后意图生效"，三方收敛）
  const stale: Tx = {
    txId: "stale",
    docId: "t",
    baseVersion: 0,
    author: "u2",
    ts: 0,
    ops: [{ type: "block.update", id: "b1", blockType: "h1", prevBlockType: "todo" }],
  };
  c2.m.applyLocal("stale", [...stale.ops]);
  const r = engine.submit(stale);
  assert.ok(!r.ok && r.reason === "CONFLICT");
  c2.m.rebuild(r.ok ? undefined : r.blocks, undefined);
  const res = exchange(c2, engine, [c1]);
  assert.equal(res.every((x) => x.ok), true);
  // 重放后的意图（h1）在当前基线上生效，三方一致
  assert.equal(engine.state.blocks[0].type, "h1");
  assert.equal(c1.m.block("b1")?.type, "h1");
  assert.equal(c2.m.block("b1")?.type, "h1");
});

test("doc.replace（快照恢复）：本地提交、他人广播、双端收敛且可撤销", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");
  // c1 先有一笔提交（v1），制造非零基线
  c1.m.applyLocal("t1", [{ type: "text.insert", blockId: "b1", offset: 5, text: "!" }]);
  exchange(c1, engine, [c2]);

  // c1 恢复到给定块集合（携带 undo 上下文 prevBlocks）
  const restoreBlocks = [
    { id: "r1", type: "h1" as const, text: "恢复标题" },
    { id: "r2", type: "todo" as const, text: "恢复待办", checked: true },
  ];
  c1.m.applyLocal("restore", [
    { type: "doc.replace", blocks: restoreBlocks, prevBlocks: c1.m.blocks.map((b) => ({ ...b })) },
  ]);
  exchange(c1, engine, [c2]);
  // 双端收敛到恢复内容
  assert.deepEqual(
    engine.state.blocks.map((b) => `${b.type}:${b.text}`),
    ["h1:恢复标题", "todo:恢复待办"],
  );
  assert.deepEqual(
    c2.m.blocks.map((b) => `${b.type}:${b.text}`),
    ["h1:恢复标题", "todo:恢复待办"],
  );
  assert.equal(c2.m.block("r2")?.checked, true);

  // c1 撤销恢复 → 回到恢复前状态，双端收敛
  const inverse = c1.m.pendingFor("restore"); // 已 ack，直接手工求逆验证
  void inverse;
  c1.m.applyLocal("undo-restore", [
    {
      type: "doc.replace",
      blocks: [
        { id: "b1", type: "text", text: "hello!" },
        { id: "b2", type: "text", text: "world" },
      ],
    },
  ]);
  exchange(c1, engine, [c2]);
  assert.deepEqual(
    engine.state.blocks.map((b) => b.id),
    ["b1", "b2"],
  );
  assert.deepEqual(
    c2.m.blocks.map((b) => b.id),
    ["b1", "b2"],
  );
});

test("adoptPending：关页恢复的未确认事务重放并补发收敛", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  // 模拟：上次会话有 2 笔未确认事务存了 localStorage
  const stored = [
    { txId: "p1", ops: [{ type: "text.insert" as const, blockId: "b1", offset: 5, text: " A" }] },
    { txId: "p2", ops: [{ type: "block.insert" as const, id: "n9", afterId: null as string | null, text: "新块" }] },
  ];
  const c1 = client(engine, "u1"); // 重新打开页面 → init 快照
  const dropped = c1.m.adoptPending(stored);
  assert.equal(dropped.length, 0);
  assert.equal(c1.m.visibleText("b1"), "hello A");
  assert.equal(c1.m.blocks[c1.m.blocks.length - 1].text, "新块");
  // 补发 → 收敛
  exchange(c1, engine, []);
  assert.equal(engine.state.blocks[0].text, "hello A");
  assert.equal(engine.state.blocks[engine.state.blocks.length - 1].text, "新块");
  // 引用已消失块的恢复事务被丢弃而非崩溃
  const c2 = client(engine, "u2");
  const dropped2 = c2.m.adoptPending([{ txId: "dead", ops: [{ type: "text.insert", blockId: "ghost", offset: 0, text: "x" }] }]);
  assert.equal(dropped2.length, 1);
});

test("回车拆块事务在双端收敛", () => {
  const engine = new DocEngine(seed(), { lockEnforced: false });
  const c1 = client(engine, "u1");
  const c2 = client(engine, "u2");
  // c1 在 "hello" 中间回车：删除尾部 + 插入新块
  const ops: Op[] = [
    { type: "text.delete", blockId: "b1", offset: 2, length: 3, text: "llo" },
    { type: "block.insert", id: "n1", afterId: "b1", text: "llo" },
  ];
  c1.m.applyLocal("split", ops);
  exchange(c1, engine, [c2]);
  assert.deepEqual(
    engine.state.blocks.map((b) => b.text),
    ["he", "llo", "world"],
  );
  assert.deepEqual(
    c2.m.blocks.map((b) => b.text),
    ["he", "llo", "world"],
  );
  // c1 的 undo 逆操作（block.delete + text.insert）也应收敛
  c1.m.applyLocal("undo-split", [
    { type: "block.delete", id: "n1", text: "llo", prevId: "b1" },
    { type: "text.insert", blockId: "b1", offset: 2, text: "llo" },
  ]);
  exchange(c1, engine, [c2]);
  assert.deepEqual(
    engine.state.blocks.map((b) => b.text),
    ["hello", "world"],
  );
  assert.deepEqual(
    c2.m.blocks.map((b) => b.text),
    ["hello", "world"],
  );
});
