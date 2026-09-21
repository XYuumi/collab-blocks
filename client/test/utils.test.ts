/**
 * 纯工具测试：Markdown 导出映射 + 块/字符级 diff。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown, sanitizeFilename } from "../src/markdown";
import { charDiff, diffBlocks } from "../src/diffutil";
import type { BlockData } from "@shared/protocol";

test("Markdown 导出：各块类型映射正确", () => {
  const blocks: BlockData[] = [
    { id: "1", type: "h1", text: "标题" },
    { id: "2", type: "text", text: "正文段落" },
    { id: "3", type: "bullet", text: "列表项" },
    { id: "4", type: "todo", text: "未做", checked: false },
    { id: "5", type: "todo", text: "已做", checked: true },
    { id: "6", type: "code", text: "console.log(1)" },
  ];
  const md = blocksToMarkdown("我的文档", blocks);
  const expected =
    [
      "# 我的文档",
      "# 标题",
      "正文段落",
      "- 列表项",
      "- [ ] 未做",
      "- [x] 已做",
      "```\nconsole.log(1)\n```",
    ].join("\n\n") + "\n";
  assert.equal(md, expected);
});

test("文件名清洗：替换非法字符", () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(sanitizeFilename("   "), "未命名文档");
});

test("字符级 diff：增删片段正确且相邻同类合并", () => {
  const segs = charDiff("hello world", "hello brave world");
  assert.deepEqual(segs, [
    { kind: "same", text: "hello " },
    { kind: "ins", text: "brave " },
    { kind: "same", text: "world" },
  ]);
  const del = charDiff("abcdef", "abc");
  assert.deepEqual(del, [
    { kind: "same", text: "abc" },
    { kind: "del", text: "def" },
  ]);
  const both = charDiff("kitten", "sitting");
  assert.equal(
    both.map((s) => `${s.kind}:${s.text}`).join("|"),
    "del:k|ins:s|same:itt|del:e|ins:i|same:n|ins:g",
  );
});

test("块级 diff：增删改行识别正确", () => {
  const old: BlockData[] = [
    { id: "a", type: "text", text: "保留" },
    { id: "b", type: "text", text: "改我" },
    { id: "c", type: "text", text: "会被删" },
  ];
  const cur: BlockData[] = [
    { id: "a", type: "text", text: "保留" },
    { id: "b", type: "text", text: "改过了" },
    { id: "d", type: "text", text: "新块" },
  ];
  const rows = diffBlocks(old, cur);
  const kinds = rows.map((r) => `${r.id}:${r.kind}`);
  assert.deepEqual(kinds, ["a:same", "b:changed", "c:removed", "d:added"]);
  const changed = rows[1];
  assert.ok(changed.kind === "changed");
  assert.equal(
    changed.segs.map((s) => `${s.kind}:${s.text}`).join("|"),
    "same:改|del:我|ins:过了",
  );
});
