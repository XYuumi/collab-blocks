/**
 * Diff（纯函数）：快照对比视图用。
 * - 块级：按 id 对齐（快照与当前共享块血统），id 只在一边 → 增/删行；
 * - 字符级：两块都有但文本不同 → LCS 最长公共子序列求增删片段（块文本有长度上限保护）。
 */
import type { BlockData } from "@shared/protocol";

export type CharSeg = { kind: "same" | "del" | "ins"; text: string };

export type DiffRow =
  | { kind: "same"; id: string; type: BlockData["type"]; text: string }
  | { kind: "changed"; id: string; type: BlockData["type"]; segs: CharSeg[] }
  | { kind: "removed"; id: string; type: BlockData["type"]; text: string }
  | { kind: "added"; id: string; type: BlockData["type"]; text: string };

const MAX_DIFF_CHARS = 2000;

/** 字符级 diff（LCS 动态规划；超过上限退化为整段删+整段增） */
export function charDiff(a: string, b: string): CharSeg[] {
  if (a === b) return [{ kind: "same", text: a }];
  if (a.length > MAX_DIFF_CHARS || b.length > MAX_DIFF_CHARS) {
    return [
      { kind: "del", text: a },
      { kind: "ins", text: b },
    ];
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: CharSeg[] = [];
  const push = (kind: CharSeg["kind"], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segs.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("ins", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return segs;
}

/** 块级 diff：快照 old → 当前 cur。按 id 对齐（顺序变化按删+增呈现）。 */
export function diffBlocks(oldBlocks: BlockData[], curBlocks: BlockData[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const curById = new Map(curBlocks.map((b) => [b.id, b]));
  const emitted = new Set<string>();
  for (const ob of oldBlocks) {
    emitted.add(ob.id);
    const cb = curById.get(ob.id);
    if (!cb) {
      rows.push({ kind: "removed", id: ob.id, type: ob.type, text: ob.text });
    } else if (cb.text !== ob.text || cb.type !== ob.type || cb.checked !== ob.checked) {
      const segs: CharSeg[] = charDiff(
        prefix(ob) + ob.text,
        prefix(cb) + cb.text,
      );
      rows.push({ kind: "changed", id: ob.id, type: cb.type, segs });
    } else {
      rows.push({ kind: "same", id: ob.id, type: ob.type, text: ob.text });
    }
  }
  for (const cb of curBlocks) {
    if (!emitted.has(cb.id)) rows.push({ kind: "added", id: cb.id, type: cb.type, text: cb.text });
  }
  return rows;
}

/** 类型/勾选变化折进文本前缀，让字符 diff 能呈现类型改动 */
function prefix(b: BlockData): string {
  switch (b.type) {
    case "h1":
    case "h2":
    case "h3":
      return `${"#".repeat(Number(b.type.slice(1)))} `;
    case "bullet":
      return "- ";
    case "todo":
      return `- [${b.checked ? "x" : " "}] `;
    case "code":
      return "```\n";
    default:
      return "";
  }
}
