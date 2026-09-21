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
