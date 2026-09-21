/**
 * main：SPA 路由入口。
 *   /            文档首页（列表/新建/登录）
 *   /d/:docId    编辑页（docId 即编辑链接凭据）
 *   /r/:roToken  只读链接 → 解析 docId 后以 view 模式进入编辑页
 */
import "./styles.css";
import { mountHome } from "./home";
import { mountEditor } from "./editor-page";

// 主题已在 index.html 首帧前应用（防 FOUC）；此处仅保留切换按钮逻辑（见 editor-page/home）。

const app = document.getElementById("app")!;
const path = location.pathname;

async function route() {
  if (path === "/" || path === "/index.html" || path === "") {
    await mountHome(app);
    return;
  }
  if (path.startsWith("/d/")) {
    const docId = decodeURIComponent(path.slice(3));
    if (!docId) {
      location.href = "/";
      return;
    }
    mountEditor(app, { docId, mode: "edit" });
    return;
  }
  if (path.startsWith("/r/")) {
    const ro = decodeURIComponent(path.slice(3));
    app.innerHTML = `<div class="home"><div class="home-hero"><p>正在打开只读链接…</p></div></div>`;
    try {
      const res = await fetch(`/api/ro/${encodeURIComponent(ro)}`);
      if (!res.ok) throw new Error();
      const { docId } = (await res.json()) as { docId: string };
      mountEditor(app, { docId, mode: "view" });
    } catch {
      app.innerHTML = `<div class="home"><div class="home-hero"><h1>链接无效</h1><p>只读链接不存在或已被撤销。</p><a class="btn" href="/">回首页</a></div></div>`;
    }
    return;
  }
  location.href = "/";
}

void route();
