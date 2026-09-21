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

/** Markdown 导入：逐行解析为块数组（标题/列表/待办/代码围栏），id 由调用方生成 */
export function markdownToBlocks(md: string, genId: () => string): BlockData[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockData[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码围栏
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过闭合围栏
      blocks.push({ id: genId(), type: "code", text: buf.join("\n") });
      continue;
    }
    // 标题
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const type = (["h1", "h2", "h3"] as const)[h[1].length - 1];
      blocks.push({ id: genId(), type, text: h[2] });
      i++;
      continue;
    }
    // 待办
    const todo = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      blocks.push({ id: genId(), type: "todo", text: todo[2], checked: todo[1].toLowerCase() === "x" });
      i++;
      continue;
    }
    // 列表
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ id: genId(), type: "bullet", text: bullet[1] });
      i++;
      continue;
    }
    // 空行跳过
    if (!line.trim()) {
      i++;
      continue;
    }
    // 段落（连续非空行合并）
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s|[-*+]\s)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push({ id: genId(), type: "text", text: buf.join("\n") });
  }
  if (blocks.length === 0) blocks.push({ id: genId(), type: "text", text: "" });
  return blocks;
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
