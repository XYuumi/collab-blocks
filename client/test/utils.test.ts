/**
 * 纯工具测试：Markdown 导出映射 + 块/字符级 diff。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { blocksToMarkdown, sanitizeFilename, markdownToBlocks } from "../src/markdown";
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


test("Markdown 导入：标题/列表/待办/代码/段落解析正确（与导出互逆）", () => {
  const id = (() => { let n = 0; return () => `b${n++}`; })();
  const md = [
    "# 项目计划",
    "",
    "这是说明段落，",
    "第二行合并。",
    "",
    "## 待办",
    "- [ ] 第一件事",
    "- [x] 已完成",
    "* 圆点列表",
    "",
    "```js",
    "console.log(1);",
    "```",
    "",
    "结尾段落",
  ].join("\n");
  const blocks = markdownToBlocks(md, id);
  assert.deepEqual(
    blocks.map((b) => `${b.type}:${b.text}${b.checked !== undefined ? (b.checked ? "[x]" : "[ ]") : ""}`),
    [
      "h1:项目计划",
      "text:这是说明段落，\n第二行合并。",
      "h2:待办",
      "todo:第一件事[ ]",
      "todo:已完成[x]",
      "bullet:圆点列表",
      "code:console.log(1);",
      "text:结尾段落",
    ],
  );
  // 空文档兜底
  const empty = markdownToBlocks("", id);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].type, "text");
  // 导出→导入 大致互逆（不带标题导出，块类型序列一致）
  const exported = blocksToMarkdown("", blocks);
  const reparsed = markdownToBlocks(exported, id);
  assert.deepEqual(
    reparsed.map((b) => b.type),
    blocks.map((b) => b.type),
  );
});
