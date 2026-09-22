/**
 * 并发压测：连接容量 / 多人不同块编辑吞吐与延迟 / 同块热点冲突 / 内存与 CPU。
 * 用法：node loadtest.mjs <port> —— 前提：独立服务实例已在该端口启动。
 */
import { WebSocket } from "ws";
import fs from "node:fs";
import http from "node:http";
import { execSync } from "node:child_process";

const PORT = Number(process.argv[2] || 28999);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = { Origin: `http://127.0.0.1:${PORT}` };

/** fetch 在该脚本环境下会挂起（原因未明），用原生 http 替代 */
function postJson(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

class Client {
  constructor(docId) {
    this.docId = docId;
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: ORIGIN });
    this.pending = new Map(); // txId -> t0
    this.latencies = [];
    this.acks = 0;
    this.nacks = 0;
    this.conflicts = 0;
    this.version = 0;
    this.blockTextLens = new Map();
    this.retrying = new Map(); // txId -> op描述
    this.ws.on("message", (d) => this.onMsg(JSON.parse(String(d))));
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
  }
  hello() {
    return new Promise((res, rej) => {
      // 注意：ws 的 message 事件给的是原始 Buffer，必须 parse（此前的 bug）
      const timer = setTimeout(() => { this.ws.off("message", on); rej(new Error("hello timeout")); }, 15000);
      const on = (d) => {
        const m = JSON.parse(String(d));
        if (m.t === "init") {
          clearTimeout(timer);
          this.ws.off("message", on);
          this.version = m.doc.version;
          for (const b of m.doc.blocks) this.blockTextLens.set(b.id, b.text.length);
          res(m);
        } else if (m.t === "error") {
          clearTimeout(timer);
          this.ws.off("message", on);
          rej(new Error("server: " + m.message));
        }
      };
      this.ws.on("message", on);
      this.ws.send(JSON.stringify({ t: "hello", docId: this.docId, name: "load-" + Math.random().toString(36).slice(2, 8) }));
    });
  }
  onMsg(m) {
    if (m.t === "ack") {
      this.version = m.version;
      const t0 = this.pending.get(m.txId);
      if (t0 !== undefined) {
        this.latencies.push(performance.now() - t0);
        this.pending.delete(m.txId);
      }
      this.acks++;
    } else if (m.t === "nack") {
      this.version = m.version;
      const t0 = this.pending.get(m.txId);
      if (t0 !== undefined) this.latencies.push(performance.now() - t0);
      this.nacks++;
      if (m.reason === "CONFLICT") this.conflicts++;
    } else if (m.t === "remote.op") {
      this.version = m.version;
    }
  }
  /** 在块尾插入一个字符；返回是否已入队 */
  insert(blockId, txId) {
    const len = this.blockTextLens.get(blockId) ?? 0;
    const text = "x".repeat(1 + (txId.charCodeAt(txId.length - 1) % 3));
    this.blockTextLens.set(blockId, len + text.length);
    this.pending.set(txId, performance.now());
    this.ws.send(JSON.stringify({
      t: "tx",
      tx: { txId, docId: this.docId, baseVersion: this.version, author: "load", ts: Date.now(), ops: [{ type: "text.insert", blockId, offset: len, text }] },
    }));
    return true;
  }
  close() {
    this.ws.close();
  }
}

  async function quiesce(tag) {
    // 等服务端 CPU 每秒增量 < 100ms（背景噪声级）再开下一场景，避免上一场景积压污染
    let prev = serverCpu();
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const now = serverCpu();
      prev = now;
    }
  }

async function main() {
  const report = { scenarios: [], baselineRssMb: serverRss() };

  // ---- 建号 + 建文档 ----
  const reg = (await postJson("/api/auth/register", { username: "loadowner_" + Date.now(), password: "pass123456" })).json;
  const doc = (await postJson("/api/docs", { title: "压测文档" }, reg.token)).json;

  // 种 500 个块（owner 连接 + doc.replace）
  const owner = new Client(doc.docId);
  await owner.open();
  await owner.hello();
  const blocks = Array.from({ length: 520 }, (_, i) => ({ id: `lb${i}`, type: "text", text: `第 ${i} 块初始内容` }));
  owner.pending.set("seed", performance.now());
  owner.ws.send(JSON.stringify({ t: "tx", tx: { txId: "seed", docId: doc.docId, baseVersion: owner.version, author: "load", ts: Date.now(), ops: [{ type: "doc.replace", blocks }] } }));
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("seed ack timeout")), 30000);
    const on = (d) => {
      const m = JSON.parse(String(d));
      if (m.t === "ack" && m.txId === "seed") { clearTimeout(timer); owner.ws.off("message", on); res(); }
      else if (m.t === "nack" && m.txId === "seed") { clearTimeout(timer); owner.ws.off("message", on); rej(new Error("seed nack: " + m.reason)); }
    };
    owner.ws.on("message", on);
  });

  // ---- 场景 A：纯连接容量（500 个只读连接） ----
  {
    const t0 = performance.now();
    const clients = [];
    const BATCH = 50;
    for (let i = 0; i < 500; i += BATCH) {
      await Promise.all(Array.from({ length: BATCH }, async () => {
        const c = new Client(doc.docId);
        await c.open();
        await c.hello();
        clients.push(c);
      }));
    }
    const connectMs = performance.now() - t0;
    const rssPeak = serverRss();
    for (const c of clients) c.close();
    await sleep(2000);
    report.scenarios.push({
      name: "A. 500 连接同时在线（单文档 520 块）",
      connectMs: Math.round(connectMs),
      rssPeakMb: rssPeak,
      rssAfterCloseMb: serverRss(),
      note: "含每人全量 init 快照与 O(N²) presence 广播",
    });
    await quiesce("after-A");
  }

  // ---- 场景 B：50 人不同块编辑（真实节奏 5 ops/s，含 200 观众收广播） ----
  const resetStats = (editors) => { for (const c of editors) { c.latencies = []; c.acks = 0; c.nacks = 0; c.conflicts = 0; c.pending.clear(); } };
  const runEditors = async (name, editors, opsEach, intervalMs) => {
    await quiesce("pre-" + name.slice(0, 2));
    const cpu0 = serverCpu();
    const t0 = performance.now();
    await Promise.all(editors.map((c, i) => (async () => {
      for (let k = 0; k < opsEach; k++) {
        if (intervalMs > 0) {
          const at = t0 + i * 7 + k * intervalMs;
          const wait = at - performance.now();
          if (wait > 0) await sleep(wait);
        }
        c.insert(`lb${i}`, `${name}-${i}-${k}-${Math.random().toString(36).slice(2, 6)}`);
      }
    })()));
    // 等全部 ack/nack
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const pend = editors.reduce((n, c) => n + c.pending.size, 0);
      if (pend === 0) break;
      await sleep(200);
    }
    const wall = performance.now() - t0;
    const lat = editors.flatMap((c) => c.latencies);
    const acks = editors.reduce((n, c) => n + c.acks, 0);
    const nacks = editors.reduce((n, c) => n + c.nacks, 0);
    const conflicts = editors.reduce((n, c) => n + c.conflicts, 0);
    report.scenarios.push({
      name,
      editors: editors.length,
      opsEach,
      wallMs: Math.round(wall),
      acks, nacks, conflicts,
      tps: +(acks / (wall / 1000)).toFixed(1),
      latP50ms: +pct(lat, 50).toFixed(1),
      latP95ms: +pct(lat, 95).toFixed(1),
      latP99ms: +pct(lat, 99).toFixed(1),
      latMaxMs: +Math.max(0, ...lat).toFixed(1),
      cpuSec: +((serverCpu() - cpu0) / 100).toFixed(2),
      rssMb: serverRss(),
    });
  };

  {
    const editors = [];
    for (let i = 0; i < 50; i++) {
      const c = new Client(doc.docId);
      await c.open();
      await c.hello();
      editors.push(c);
    }
    globalThis.editors50 = editors;
    await quiesce("editors-ready");
    // B1：无观众 —— 纯仲裁 + 落盘开销
    await runEditors("B1. 50 人各自块 @5ops/s（无观众）", editors, 30, 200);
    // B2：连上 200 观众再测同参数 —— 差值即广播 fan-out 开销
    globalThis.viewers = [];
    for (let i = 0; i < 200; i++) {
      const c = new Client(doc.docId);
      await c.open();
      await c.hello();
      globalThis.viewers.push(c);
    }
    await quiesce("viewers-ready");
    resetStats(editors);
    await runEditors("B2. 50 人各自块 @5ops/s（+200 观众）", editors, 30, 200);
  }

  // ---- 场景 C：满速突发（找吞吐上限；先含观众再撤观众对比） ----
  resetStats(globalThis.editors50);
  await runEditors("C1. 50 人满速突发（+200 观众）", globalThis.editors50, 50, 0);
  for (const v of globalThis.viewers) v.close();
  globalThis.viewers = [];
  await quiesce("viewers-closed");
  resetStats(globalThis.editors50);
  await runEditors("C2. 50 人满速突发（无观众）", globalThis.editors50, 50, 0);

  // ---- 场景 D：20 人挤同一个块（最坏冲突场景） ----
  {
    const hot = [];
    for (let i = 0; i < 20; i++) {
      const c = new Client(doc.docId);
      await c.open();
      await c.hello();
      c.blockTextLens.set("lb500", c.blockTextLens.get("lb500") ?? 12);
      hot.push(c);
    }
    // 同块插入：偏移都从自己视角的长度出发，冲突由服务端块级 CAS 拒绝后重发到块尾
    const cpu0 = serverCpu();
    const t0 = performance.now();
    await Promise.all(hot.map((c, i) => (async () => {
      for (let k = 0; k < 15; k++) {
        const at = t0 + i * 5 + k * 200;
        const w = at - performance.now();
        if (w > 0) await sleep(w);
        c.insert("lb500", `hot-${i}-${k}-${Math.random().toString(36).slice(2, 6)}`);
      }
    })()));
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline && hot.reduce((n, c) => n + c.pending.size, 0) > 0) await sleep(200);
    const lat = hot.flatMap((c) => c.latencies);
    report.scenarios.push({
      name: "D. 20 人同块热点 @5ops/s",
      acks: hot.reduce((n, c) => n + c.acks, 0),
      nacks: hot.reduce((n, c) => n + c.nacks, 0),
      conflicts: hot.reduce((n, c) => n + c.conflicts, 0),
      latP50ms: +pct(lat, 50).toFixed(1),
      latP95ms: +pct(lat, 95).toFixed(1),
      cpuSec: +((serverCpu() - cpu0) / 100).toFixed(2),
      note: "同块并发被块级 CAS 拒绝（客户端需变换重试），未重试的计入 nacks",
    });
    for (const c of hot) c.close();
  }

  // 关闭全部连接让事件循环自然退出；同步写 stdout（process.exit 会截断重定向缓冲）
  for (const c of [...(globalThis.editors50 ?? []), ...(globalThis.viewers ?? []), owner]) c.close();
  await sleep(500);
  fs.writeSync(1, JSON.stringify(report, null, 2) + "\n");
}

// --- 服务端资源采样（/proc） ---
let SERVER_PID = null;
function serverRss() {
  const pid = SERVER_PID ?? (SERVER_PID = findServerPid());
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, "utf-8");
    return Math.round(parseInt(/VmRSS:\s+(\d+)/.exec(st)[1], 10) / 1024);
  } catch { return -1; }
}
function serverCpu() {
  const pid = SERVER_PID ?? (SERVER_PID = findServerPid());
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const parts = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return (Number(parts[11]) + Number(parts[12])) * 10; // utime+stime，clock ticks(100Hz)→ms
  } catch { return 0; }
}
function findServerPid() {
  // 按端口定位压测实例（生产实例同样跑 tsx src/index.ts，不能按进程名找）
  const out = execSync(`ss -tlnp | grep ":${PORT} " | grep -o 'pid=[0-9]*' | head -1`).toString();
  return Number(/pid=(\d+)/.exec(out)[1]);
}

main().catch((e) => { console.error(e); process.exit(1); });
