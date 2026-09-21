/**
 * StatusUI：顶栏（品牌/名字/presence/锁开关/快照/主题/登录槽）+
 * 底部状态条（连接/版本/待同步/字数）+ Toast（去重）+ 离线横幅。
 */
import type { NetState } from "./net";

export class StatusUI {
  readonly dot: HTMLElement;
  readonly stateText: HTMLElement;
  readonly versionText: HTMLElement;
  readonly pendingText: HTMLElement;
  readonly statsText: HTMLElement;
  readonly lockToggle: HTMLInputElement;
  readonly banner: HTMLElement;
  readonly toastsEl: HTMLElement;
  readonly userSlot: HTMLElement;
  readonly themeBtn: HTMLButtonElement;
  private headerEl: HTMLElement;
  private recentToasts = new Map<string, number>();

  constructor(
    onToggleLock: (enforced: boolean) => void,
    onOpenSnapshots: () => void,
  ) {
    const header = document.createElement("header");
    header.className = "topbar";
    header.innerHTML = `
      <div class="brand">协同编辑器<span class="brand-sub">Collab Editor</span></div>
      <input class="name-input" maxlength="24" placeholder="我的名字" title="修改显示名称（全局唯一）" />
      <div class="presence"></div>
      <div class="spacer"></div>
      <div class="user-slot"></div>
      <button class="btn theme-btn" title="切换明暗主题">🌙</button>
      <label class="lock-toggle" title="开启后：一个块同一时间只允许持锁者编辑（服务器强制拒绝他人写入）">
        <input type="checkbox" class="lock-toggle-input" /> 强制块锁
      </label>
      <button class="btn snapshots-btn">历史快照</button>
    `;
    document.body.prepend(header);

    const bar = document.createElement("div");
    bar.className = "statusbar";
    bar.innerHTML = `
      <span class="dot"></span>
      <span class="state-text">连接中…</span>
      <span class="sep">·</span>
      <span class="version-text">v0</span>
      <span class="sep">·</span>
      <span class="pending-text">待同步 0</span>
      <span class="sep">·</span>
      <span class="stats-text">0 字</span>
    `;
    document.body.appendChild(bar);

    const banner = document.createElement("div");
    banner.className = "offline-banner";
    banner.textContent = "⚠ 连接已断开，正在重连…（你的编辑已保留在本地，重连后自动同步）";
    document.body.appendChild(banner);

    const toasts = document.createElement("div");
    toasts.className = "toasts";
    document.body.appendChild(toasts);

    this.dot = bar.querySelector(".dot")!;
    this.stateText = bar.querySelector(".state-text")!;
    this.versionText = bar.querySelector(".version-text")!;
    this.pendingText = bar.querySelector(".pending-text")!;
    this.statsText = bar.querySelector(".stats-text")!;
    this.banner = banner;
    this.toastsEl = toasts;
    this.lockToggle = header.querySelector(".lock-toggle-input")!;
    this.lockToggle.addEventListener("change", () => onToggleLock(this.lockToggle.checked));

    header.querySelector(".snapshots-btn")!.addEventListener("click", onOpenSnapshots);

    this.headerEl = header;
    this.userSlot = header.querySelector(".user-slot")!;
    this.themeBtn = header.querySelector(".theme-btn")!;
  }

  get nameInput(): HTMLInputElement {
    return this.headerEl.querySelector(".name-input")!;
  }

  get presenceEl(): HTMLElement {
    return this.headerEl.querySelector(".presence")!;
  }

  setConnection(state: NetState) {
    this.dot.className = `dot ${state}`;
    this.stateText.textContent =
      state === "open" ? "已连接" : state === "connecting" ? "连接中…" : "已断开";
    this.banner.classList.toggle("show", state === "closed" || state === "connecting");
  }

  setVersion(version: number, pending: number) {
    this.versionText.textContent = `v${version}`;
    this.pendingText.textContent = `待同步 ${pending}`;
    this.pendingText.classList.toggle("hot", pending > 0);
  }

  setStats(chars: number) {
    this.statsText.textContent = `${chars} 字`;
  }

  setLockEnforced(enforced: boolean) {
    if (this.lockToggle.checked !== enforced) this.lockToggle.checked = enforced;
  }

  /** 同一文案 2.5s 内只提示一次（避免冲突风暴刷屏） */
  toast(msg: string, kind: "info" | "warn" | "error" = "info") {
    const now = Date.now();
    const last = this.recentToasts.get(msg + kind) ?? 0;
    if (now - last < 2500) return;
    this.recentToasts.set(msg + kind, now);
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    this.toastsEl.appendChild(el);
    setTimeout(() => el.classList.add("fade"), 3600);
    setTimeout(() => el.remove(), 4200);
    while (this.toastsEl.children.length > 5) this.toastsEl.firstElementChild?.remove();
  }
}
