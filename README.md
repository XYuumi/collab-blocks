# Collab Blocks · 协同编辑器（DOM 渲染 · Block 模型 · 多文档协作）

基于 DOM 渲染的块结构协同编辑器，像一个小型腾讯文档：**登录后创建文档、生成编辑/只读两种分享链接**；多人同时打开同一文档，输入/删除实时同步，带**远程光标与选区高亮**、块级**评论线程**、块锁、块类型（标题/列表/待办/代码块 + `/` 菜单 + Markdown 快捷输入）、**全文搜索**、**Markdown 导出**、断线重连补发、冲突自动合并、Undo/Redo、版本与快照（**一键恢复 + 与当前对比**）、关页后未同步编辑恢复、大纲导航、**回收站**、明暗主题（无闪烁）、手机响应式。**不使用 OT/CRDT**，用「版本 + 块级 CAS + 拒绝后自动重试」保证收敛。数据与用户存于 SQLite。

> 设计文档见 `docs/`：01 功能 · 02 架构与数据结构 · 03 同步协议 · 04 冲突与一致性 · 05 设计自问自答（题目全部思考题逐条作答）· 06 代码审查报告 · 07 技术选型对比（原生 vs 框架 vs TipTap+Yjs）。

## 1. 怎么运行

```bash
npm install      # Node ≥ 22（推荐 24；npm workspaces）
npm test         # 47 个测试：引擎/WS 协议/认证存储/多文档权限 + 客户端双模型收敛
npm run build    # 构建前端
npm start        # 启动 → http://localhost:3000
```

开发模式：`npm run dev`（Vite 5173 热更新，/ws 与 /api 代理到 3000）。数据在 `data/collab.db`。

**体验协同**：注册登录 → 首页"＋新建文档" → 点"分享"复制链接 → 另一个标签页（或浏览器）打开即可协作。只读链接打开的人只能看不能改；登录态按标签页隔离，双开即是两个用户。

## 2. 使用的技术

- **前端**：TypeScript + Vite + **原生 DOM（无框架）**——contenteditable 的光标/IME 状态必须精确到节点地控制，框架重渲染是这类编辑器的经典坑；选型详析见 `docs/07`；响应式适配手机浏览器（无 UI 框架依赖）；
- **编辑模型**：每 Block 一个 `contenteditable="plaintext-only"`，`input` 后前后缀 diff 推导操作；块类型支持 `/` 菜单与 Markdown 快捷输入（`# `/`- `/`[ ] `/```` ``` ````）；
- **后端**：Node.js + `ws` + Express 单端口；多文档 = 连接绑定文档（房间模型）+ 多引擎懒加载（LRU）；
- **数据库**：Node 内置 `node:sqlite`（零原生依赖）：users / sessions / docs / snapshots；**每次提交事务落盘**（重启零丢失）；密码 scrypt 加盐哈希 + 会话 token；
- **测试**：node:test ×47（引擎单元 / WS 集成 / 认证与存储 / 多文档与权限矩阵 / 客户端模型双端收敛）。

## 3. 数据结构

```
Document = { version, structureVersion, blocks: Block[] }        // 服务器为唯一权威
Block    = { id: UUID, type: text|h1|h2|h3|bullet|todo|code, text, checked? }
         + 服务器簿记 { blockVersion, lastWriter }                // 块级 CAS 依据
Op  = block.insert(id, afterId, text, blockType?) | block.delete(id)
    | block.update(id, blockType?, checked?) | doc.replace(blocks)   // 快照恢复
    | text.insert(blockId, offset, text) | text.delete(blockId, offset, length)
Tx  = { txId, baseVersion, ops[] }                                // 原子提交/幂等重试/撤销单位
docs 表另含 owner_id / title / ro_token（只读链接）/ enforce_owner_edit
```

要点：操作用 **BlockId/afterId 锚定而非下标**；`version` 全局单调 + 每块 `blockVersion` 细化 CAS，**不同块并发永不冲突**。→ 详见 `docs/02`

## 4. 协同怎么实现

- **乐观更新**：键入本地立即可见，打包为 Tx（30ms 合批）经 WebSocket 提交，服务器逐个 ACK（附新版本）并按文档房间广播 `remote.op`；
- **服务器仲裁**：txId 幂等去重 → 角色检查（viewer 拒写）→ 块锁检查 → **块级 CAS** → 副本原子应用 → version+1 → SQLite 落盘；
- **同块冲突**：后到者被拒（附权威文本）→ 客户端把 pending 操作做"块内微型变换"→ 以新基线自动重试 → 双方输入都保留；
- **可靠性**：超时 5s 同 txId 重发；断线指数退避重连 + `sync` 对账（防重复应用）；**未确认编辑实时落 localStorage，关页重开自动恢复补发**；
- **多文档与权限**：hello 绑定 docId（房间隔离）；`/d/:docId` 编辑链接（UUID 即凭据）、`/r/:token` 只读链接、"仅创建者可编辑"开关全部在服务器侧强制；
- **快照恢复**：恢复 = 提交一个 `doc.replace` 事务（原子、可撤销、他人端实时同步）。→ 时序图 `docs/03`，收敛论证 `docs/04`

## 5. 遇到的问题（摘，完整清单见 docs/06）

1. 结构调和不同步已有块文本 → 重连后 DOM 陈旧且会污染后续 diff（已修复+回归覆盖）；
2. 身份伪造（hello 任意 userId 绕过块锁）与跨站 WS 劫持 → token 身份 + Origin 校验；
3. 多文档改造时锁检查接线丢失（强制锁失效）→ 被测试当场抓住，改为 DocManager 注入点；
4. 弹窗关闭后 Ctrl+Z 失效（焦点不在编辑器）→ 撤销提升为页面级快捷键；
5. 复选框与文字重叠（绝对定位擦边）→ 改为文档流 flex 子元素，结构性杜绝。

## 6. 还没完成的

- 撤销不感知他人同块修改（选择性撤销属研究级，路线见 docs/04）；
- 块内富文本样式（跨字符加粗等，需要 Peritext 级 CRDT，路线见 docs/04）；
- HTTP 未加 TLS（公网部署前置 HTTPS 即可；本项目 token 走请求体非 Cookie，CSRF 不适用）；
- 协作者名单式权限（目前是链接即凭据 + enforceOwnerEdit 开关的近似）；
- 水平扩展（多进程需 Redis 广播/文档分片，单机演示不需要）。

## 7. 继续开发的优化方向

1. **可靠性**：版本化 op log 增量对账（替代全量快照，大文档带宽友好）；
2. **合并质量**：块内变换升级为完整双边变换（OT-lite），或块内文本层引入 CRDT（Yjs）、块结构层保持现有 CAS；
3. **产品**：协作者名单与逐人权限、评论线程、选区（不仅是插入点）同步、文档搜索；
4. **部署**：HTTPS（caddy/nginx 一行反代）、多进程 + Redis pub/sub 分片；
5. **性能**：广播按脏块打包、大文档虚拟滚动。
