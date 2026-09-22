/**
 * presence 两段式探活测试（v15）：
 * 修复背景——饱和积压时 lastSeen 随消息处理滞后，旧逻辑直接按它 terminate，
 * 压测中活着的编辑连接被整批误杀。新逻辑：空闲超时先 ping，累计 2×超时无响应才剔除。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { buildServer } from "../src/index";
import { DOC_ID, type ServerMsg } from "../../shared/protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmpDb() {
  return path.join(os.tmpdir(), `collab-presence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
  hello() {
    this.ws.send(JSON.stringify({ t: "hello", docId: this.docId, name: "presence-t" }));
    return new Promise((res) => {
      const on = (d: string) => {
        if (JSON.parse(d).t === "init") {
          this.ws.off("message", on);
          res(null);
        }
      };
      this.ws.on("message", on);
    });
  }
  close() {
    this.ws.close();
  }
}

test("presence 探活：空闲活连接不被误杀；停止响应的连接两倍超时后剔除", async () => {
  // 空闲阈值 300ms、清扫 100ms（须满足 清扫间隔 << 空闲阈值）
  const s = buildServer(tmpDb(), { presenceTimeoutMs: 300, sweepIntervalMs: 100 });
  const l = await s.listen(0);
  const c = await new C(l.port, DOC_ID).open();
  try {
    await c.hello();
    assert.equal(s.hub.onlineCount, 1);
    // 空闲但活着（ws 客户端自动回 pong）：旧逻辑在 ~1×300ms+清扫间隔内就会误杀
    await sleep(1600);
    assert.equal(s.hub.onlineCount, 1);
    // 模拟死亡：暂停底层 socket 读取（收到 ping 也不回 pong）
    (c.ws as unknown as { _socket: { pause: () => void } })._socket.pause();
    await sleep(1600);
    assert.equal(s.hub.onlineCount, 0);
  } finally {
    c.close();
    await l.close();
  }
});
