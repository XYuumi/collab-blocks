/**
 * LockManager（客户端）：块锁的申请/续期/释放与 UI 呈现。
 *
 * - 聚焦某块即向服务器申请锁（广播给他人：彩色边框 + 名牌）；
 *   失焦释放；持锁期间每 5s 续期（服务器 TTL 15s，防僵死锁）。
 * - 强制模式（服务器配置）：他人持锁块的 contenteditable 置为 false，
 *   服务器侧拒绝仍作为最终防线（竞态窗口兜底）。
 * - 咨询模式：锁只做视觉提示，不阻止编辑（用于对比演示）。
 */
import type { ClientMsg, LockState, Op, UserInfo, DocConfig } from "@shared/protocol";
import type { Net } from "./net";
import type { Editor, LockRenderInfo } from "./editor";

export class LockManager {
  locks = new Map<string, { holder: UserInfo; expiresAt: number }>();
  lockEnforced = false;
  me: UserInfo | null = null;
  private focusedBlockId: string | null = null;

  constructor(
    private net: Net,
    private editor: Editor,
    private toast: (msg: string, kind?: "info" | "warn" | "error") => void,
  ) {
    editor.lockInfoProvider = (blockId) => this.renderInfo(blockId);
    window.setInterval(() => {
      if (this.focusedBlockId) this.send({ t: "lock.acquire", blockId: this.focusedBlockId });
    }, 5000);
  }

  private send(msg: ClientMsg) {
    this.net.send(msg);
  }

  setMe(you: UserInfo) {
    this.me = you;
  }

  loadInit(locks: LockState[], config: DocConfig) {
    this.locks = new Map(locks.map((l) => [l.blockId, { holder: l.holder, expiresAt: l.expiresAt }]));
    this.lockEnforced = config.lockEnforced;
    this.editor.renderLocks();
  }

  focus(blockId: string) {
    this.focusedBlockId = blockId;
    this.send({ t: "lock.acquire", blockId });
  }

  blur(blockId: string) {
    if (this.focusedBlockId === blockId) this.focusedBlockId = null;
    this.send({ t: "lock.release", blockId });
  }

  reacquire() {
    if (this.focusedBlockId) this.send({ t: "lock.acquire", blockId: this.focusedBlockId });
  }

  onChanged(blockId: string, lock: LockState | null) {
    if (lock) this.locks.set(blockId, { holder: lock.holder, expiresAt: lock.expiresAt });
    else this.locks.delete(blockId);
    this.editor.renderLocks();
  }

  onDenied(blockId: string, holder: UserInfo) {
    this.toast(`块 #${blockId.slice(0, 4)} 正被 ${holder.name} 编辑，暂不能修改`, "warn");
    this.editor.renderLocks();
  }

  setConfig(config: DocConfig) {
    this.lockEnforced = config.lockEnforced;
    this.editor.renderLocks();
  }

  isLockedByOther(blockId: string): boolean {
    const l = this.locks.get(blockId);
    if (!l || l.expiresAt <= Date.now()) return false;
    return l.holder.userId !== this.me?.userId;
  }

  /** NACK-LOCKED 重建时的丢弃过滤：对他人持锁块的写操作丢弃 */
  dropFilterForOp(op: Op): string | null {
    const blockId =
      op.type === "text.insert" || op.type === "text.delete"
        ? op.blockId
        : op.type === "block.delete" || op.type === "block.update"
          ? op.id
          : null;
    if (blockId && this.isLockedByOther(blockId)) return "目标块被其他用户锁定";
    return null;
  }

  private renderInfo(blockId: string): LockRenderInfo {
    if (!this.isLockedByOther(blockId)) return { holder: null, enforced: this.lockEnforced };
    const l = this.locks.get(blockId)!;
    return { holder: l.holder, enforced: this.lockEnforced };
  }
}
