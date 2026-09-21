/**
 * AuthUI：注册 / 登录 / 登出 / 改名（HTTP + 会话 token）。
 *
 * - 密码经 scrypt 加盐哈希存储在服务器 SQLite；客户端只持有 token；
 * - token 存 sessionStorage（按标签页隔离）：两个标签页 = 两个独立会话，
 *   登录后刷新页面仍保持登录；未登录则以访客身份协作；
 * - 用户名全局唯一（大小写不敏感），注册与改名都会得到明确的错误提示。
 */
import type { UserInfo } from "@shared/protocol";

export type AuthMode = "login" | "register";

export function getToken(): string {
  return sessionStorage.getItem("ce-token") ?? "";
}

/** 独立登录/注册弹窗（首页与编辑页共用）。成功后存 token 并刷新页面。 */
export function openAuthModal(initial: AuthMode) {
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `
    <div class="auth-modal">
      <div class="auth-tabs">
        <button data-mode="register">注册</button>
        <button data-mode="login">登录</button>
      </div>
      <div class="auth-body">
        <input class="auth-username" placeholder="用户名（2-24 字符，全局唯一）" maxlength="24" autocomplete="username" />
        <input class="auth-password" type="password" placeholder="密码（至少 3 位）" autocomplete="current-password" />
        <div class="auth-error"></div>
        <button class="btn auth-submit">提交</button>
        <p class="auth-hint">不登录也可以继续以访客身份协作；登录态按标签页隔离（方便双开演示）。</p>
      </div>
    </div>`;
  document.body.appendChild(mask);

  let curMode: AuthMode = initial;
  const tabs = mask.querySelectorAll<HTMLButtonElement>(".auth-tabs button");
  const syncTabs = () => {
    tabs.forEach((b) => b.classList.toggle("active", b.dataset.mode === curMode));
    mask.querySelector<HTMLButtonElement>(".auth-submit")!.textContent =
      curMode === "register" ? "注册并登录" : "登录";
  };
  syncTabs();
  tabs.forEach((b) =>
    b.addEventListener("click", () => {
      curMode = (b.dataset.mode as AuthMode) ?? "login";
      syncTabs();
    }),
  );

  const username = mask.querySelector<HTMLInputElement>(".auth-username")!;
  const password = mask.querySelector<HTMLInputElement>(".auth-password")!;
  const error = mask.querySelector<HTMLElement>(".auth-error")!;
  const submit = mask.querySelector<HTMLButtonElement>(".auth-submit")!;

  mask.addEventListener("click", (e) => {
    if (e.target === mask) mask.remove();
  });
  const doSubmit = async () => {
    error.textContent = "";
    submit.disabled = true;
    try {
      const res = await fetch(`/api/auth/${curMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.value.trim(), password: password.value }),
      });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        error.textContent = data.error ?? "操作失败";
        return;
      }
      sessionStorage.setItem("ce-token", data.token);
      sessionStorage.setItem("ce-name", username.value.trim());
      setTimeout(() => location.reload(), 300);
    } catch {
      error.textContent = "网络错误，请稍后再试";
    } finally {
      submit.disabled = false;
    }
  };
  submit.addEventListener("click", doSubmit);
  password.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSubmit();
  });
  username.addEventListener("keydown", (e) => {
    if (e.key === "Enter") password.focus();
  });
  setTimeout(() => username.focus(), 50);
}

export async function logout() {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: getToken() }),
    });
  } catch {
    /* 忽略 */
  }
  sessionStorage.removeItem("ce-token");
  location.reload();
}

export class AuthUI {
  private me: UserInfo | null = null;
  onToast: (msg: string, kind?: "info" | "warn" | "error") => void = () => {};

  constructor(private mount: HTMLElement) {}

  setSession(you: UserInfo) {
    this.me = you;
    this.renderHeader();
  }

  private renderHeader() {
    this.mount.innerHTML = "";
    if (!this.me) return;
    if (this.me.isGuest) {
      const btn = document.createElement("button");
      btn.className = "btn login-btn";
      btn.textContent = "登录 / 注册";
      btn.title = "注册账号后颜色与名字固定，可随时回来继续";
      btn.addEventListener("click", () => openAuthModal("register"));
      this.mount.appendChild(btn);
    } else {
      const chip = document.createElement("span");
      chip.className = "user-chip";
      chip.textContent = this.me.name;
      chip.style.background = this.me.color;
      chip.title = "已登录";
      const out = document.createElement("button");
      out.className = "btn logout-btn";
      out.textContent = "退出";
      out.addEventListener("click", () => void logout());
      this.mount.appendChild(chip);
      this.mount.appendChild(out);
    }
  }

  /** 改名（访客与登录用户均可），返回错误信息或 null */
  async rename(name: string): Promise<string | null> {
    const token = getToken();
    if (!token || !this.me) return "尚未连接";
    try {
      const res = await fetch("/api/auth/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name }),
      });
      const data = (await res.json()) as { user?: UserInfo; error?: string };
      if (!res.ok || !data.user) return data.error ?? "改名失败";
      this.me = { ...this.me, name: data.user.name, color: data.user.color };
      this.renderHeader();
      return null;
    } catch {
      return "网络错误";
    }
  }
}
