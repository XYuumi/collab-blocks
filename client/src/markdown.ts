/**
 * Markdown 导出（纯函数）：块模型 → Markdown 文本。
 * 映射：h1/h2/h3 → #/##/###；bullet → "- "；todo → "- [ ]"/"- [x]"；code → ``` 围栏；正文原样。
 */
import type { BlockData } from "@shared/protocol";

export function blocksToMarkdown(title: string, blocks: BlockData[]): string {
  const parts: string[] = [];
  if (title && title.trim()) parts.push(`# ${title.trim()}`);
  for (const b of blocks) {
    const text = b.text ?? "";
    switch (b.type) {
      case "h1":
      case "h2":
      case "h3": {
        const level = "#".repeat(Number(b.type.slice(1)));
        parts.push(`${level} ${text}`);
        break;
      }
      case "bullet":
        parts.push(`- ${text}`);
        break;
      case "todo":
        parts.push(`- [${b.checked ? "x" : " "}] ${text}`);
        break;
      case "code":
        parts.push("```\n" + text + "\n```");
        break;
      default:
        parts.push(text);
    }
  }
  // 块之间空一行
  return parts.join("\n\n") + "\n";
}

export function sanitizeFilename(name: string): string {
  return (name.trim() || "未命名文档").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

/** 纯文本导出：保留最简类型前缀，适合粘贴到任意地方 */
export function blocksToPlainText(blocks: BlockData[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const text = b.text ?? "";
    switch (b.type) {
      case "h1":
      case "h2":
      case "h3":
        parts.push(text);
        break;
      case "bullet":
        parts.push(`• ${text}`);
        break;
      case "todo":
        parts.push(`[${b.checked ? "x" : " "}] ${text}`);
        break;
      default:
        parts.push(text);
    }
  }
  return parts.join("\n") + "\n";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML 导出：语义化标签 + 转义（图片块输出 img，data URL 内联） */
export function blocksToHtml(title: string, blocks: BlockData[]): string {
  const body = blocks
    .map((b) => {
      const text = esc(b.text ?? "");
      switch (b.type) {
        case "h1":
          return `<h1>${text}</h1>`;
        case "h2":
          return `<h2>${text}</h2>`;
        case "h3":
          return `<h3>${text}</h3>`;
        case "bullet":
          return `<ul><li>${text}</li></ul>`;
        case "todo":
          return `<ul><li>${b.checked ? "☑" : "☐"} ${text}</li></ul>`;
        case "code":
          return `<pre><code>${text}</code></pre>`;
        case "image":
          return `<p><img src="${b.src ?? ""}" alt="${text}" style="max-width:100%"></p>`;
        default:
          return `<p>${text}</p>`;
      }
    })
    .join("\n");
  return `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}
