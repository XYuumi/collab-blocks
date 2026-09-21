/**
 * Net：WebSocket 连接管理（指数退避重连 + 心跳）。
 *
 * - 身份：服务端签发的会话 token 存 sessionStorage（按标签页隔离——同一浏览器
 *   开两个标签页即是两个会话/用户，方便演示；刷新页面身份不变）。
 * - 断线期间上层（TxQueue）保留未确认 Tx，重连成功后走 sync 对账补发。
 */
import type { ClientMsg, ServerMsg } from "@shared/protocol";

export type NetState = "connecting" | "open" | "closed";

const TOKEN_KEY = "ce-token";
const NAME_KEY = "ce-name"; // 访客昵称偏好（服务端创建访客时优先使用）

export class Net {
  ws: WebSocket | null = null;
  state: NetState = "closed";

  private backoff = 500;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private intentional = false;

  /** 绑定到指定文档；mode="view" 表示以只读身份连接 */
  constructor(
    public docId: string,
    public mode: "edit" | "view" = "edit",
  ) {}

  onMessage: (m: ServerMsg) => void = () => {};
  onStateChange: (s: NetState) => void = () => {};

  get token(): string {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  }

  /** 收到 init 时保存服务端签发的 token */
  saveToken(token: string) {
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  get preferredName(): string {
    return sessionStorage.getItem(NAME_KEY) ?? "";
  }

  savePreferredName(name: string) {
    sessionStorage.setItem(NAME_KEY, name);
  }

  connect() {
    this.intentional = false;
    this.openSocket();
  }

  private openSocket() {
    this.setState("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.setState("open");
      this.send({
        t: "hello",
        docId: this.docId,
        token: this.token || undefined,
        name: this.preferredName || undefined,
        mode: this.mode === "view" ? "view" : undefined,
      });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data as string));
      } catch (err) {
        console.error("[net] bad message:", err);
      }
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.setState("closed");
      if (!this.intentional) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose 随之触发 */
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff + Math.random() * 300; // 抖动避免雪崩
    this.backoff = Math.min(this.backoff * 2, 8000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private setState(s: NetState) {
    this.state = s;
    this.onStateChange(s);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ t: "ping" });
    }, 5000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  get open(): boolean {
    return this.state === "open" && this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): boolean {
    if (!this.open) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  close() {
    this.intentional = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close(1000);
  }
}
