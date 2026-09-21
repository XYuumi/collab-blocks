/**
 * Presence：在线用户列表（头像 chips），同时作为用户名/颜色的查询源。
 */
import type { UserInfo } from "@shared/protocol";

export class Presence {
  users = new Map<string, UserInfo>();
  me: UserInfo | null = null;

  constructor(private el: HTMLElement) {}

  setMe(you: UserInfo) {
    this.me = you;
    this.render();
  }

  update(list: UserInfo[]) {
    this.users = new Map(list.map((u) => [u.userId, u]));
    this.render();
  }

  getUser(userId: string): UserInfo | undefined {
    return this.users.get(userId) ?? (this.me?.userId === userId ? this.me : undefined);
  }

  private render() {
    this.el.innerHTML = "";
    const all = this.me ? [this.me, ...[...this.users.values()].filter((u) => u.userId !== this.me!.userId)] : [...this.users.values()];
    for (const u of all) {
      const chip = document.createElement("span");
      chip.className = "avatar-chip" + (this.me?.userId === u.userId ? " me" : "");
      chip.title = u.name;
      chip.textContent = u.name.slice(0, 1).toUpperCase();
      chip.style.background = u.color;
      this.el.appendChild(chip);
    }
    const count = document.createElement("span");
    count.className = "online-count";
    count.textContent = `${all.length} 人在线`;
    this.el.appendChild(count);
  }
}
