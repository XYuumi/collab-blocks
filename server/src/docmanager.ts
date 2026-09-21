/**
 * DocManager：多文档引擎运行时（懒加载 + LRU 淘汰）。
 * - 每个 docId 一个 DocEngine（内存态），首次访问从 SQLite 装载；
 * - 每次提交都同步落盘（engine.onCommit），因此 LRU 淘汰不丢数据，重新访问时重载；
 * - 单文档的仲裁仍是串行的（单引擎单线程），文档之间天然隔离。
 */
import { DocEngine, type DocState } from "./engine";
import type { Store } from "./store";

const MAX_ENGINES = 64;

export class DocManager {
  private engines = new Map<string, DocEngine>(); // Map 迭代序 = 插入序，复用即删除重插实现 LRU

  /** 锁检查注入点（Hub 提供）：`(docId, blockId, userId) => 是否被他人持锁` */
  lockChecker: (docId: string, blockId: string, userId: string) => boolean = () => false;

  constructor(private store: Store) {}

  /** 取引擎；文档不存在返回 null */
  get(docId: string): DocEngine | null {
    if (!docId || typeof docId !== "string") return null;
    const hit = this.engines.get(docId);
    if (hit) {
      this.engines.delete(docId);
      this.engines.set(docId, hit); // 刷新 LRU 位次
      return hit;
    }
    const state = this.store.loadDoc(docId);
    if (!state) return null;
    const engine = this.createEngine(state);
    this.engines.set(docId, engine);
    this.evictIfNeeded();
    return engine;
  }

  /** 预热（如内置示例文档） */
  preload(state: DocState): DocEngine {
    const engine = this.createEngine(state);
    this.store.saveDoc(state);
    this.engines.set(state.docId, engine);
    this.evictIfNeeded();
    return engine;
  }

  unload(docId: string) {
    const e = this.engines.get(docId);
    if (e) {
      this.store.saveDoc(e.state); // 卸载前兜底落盘
      this.engines.delete(docId);
    }
  }

  get size(): number {
    return this.engines.size;
  }

  private createEngine(state: DocState): DocEngine {
    const engine = new DocEngine(state, { lockEnforced: false });
    engine.setLockChecker((blockId, userId) => this.lockChecker(state.docId, blockId, userId));
    engine.onCommit = () => {
      this.store.saveDoc(engine.state);
      this.store.touchDoc(state.docId);
    };
    engine.onSnapshot = () => this.store.writeSnapshot(engine.snapshot());
    return engine;
  }

  private evictIfNeeded() {
    while (this.engines.size > MAX_ENGINES) {
      const oldest = this.engines.keys().next().value;
      if (oldest === undefined) break;
      this.unload(oldest);
    }
  }
}
