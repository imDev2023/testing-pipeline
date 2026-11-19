// node --test scripts/move-repo/move.test.mjs
// The move's pure parts, against made-up private sources in a temporary folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = mkdtempSync(join(tmpdir(), "move-test-"));
mkdirSync(join(cfg, "research", "x"), { recursive: true });
mkdirSync(join(cfg, "purge"), { recursive: true });
const posts = Array.from({ length: 120 }, (_, i) => JSON.stringify({ id: `${1000 + i}`, text: `filler post number ${i} about nothing at all here today` }));
posts.push(JSON.stringify({ id: "42", text: "I want a pool that lends the spare part of its liquidity out somewhere else" }));
writeFileSync(join(cfg, "research", "x", "posts.jsonl"), posts.join("\n") + "\n");
writeFileSync(join(cfg, "research", "metallegbob.md"), "# Profile\n\nHe runs a small factory of odd markets on a fast chain since last spring.\n");
writeFileSync(join(cfg, "private-lines.txt"), Array.from({ length: 12 }, (_, i) => `secret line ${i} zebra`).join("\n") + "\n");
writeFileSync(join(cfg, "purge", "marks.txt"), "plain words\nother words\nthird words\n");
process.env.TP_CONFIG_DIR = cfg;

const scan = await import("./scan.mjs");
const move = await import("./move.mjs");
const needles = scan.loadNeedles();

test("a quote of eight words or more is found however it is wrapped or punctuated", () => {
  assert.deepEqual(scan.findIn("He asked for “a pool that lends the spare\npart of its LIQUIDITY out”, so we build it.", needles), ["x post 42"]);
  assert.deepEqual(scan.findIn("a pool that lends the spare part", needles), []); // seven words
});

test("a profile sentence and a private line are found; file names are not words", () => {
  assert.deepEqual(scan.findIn("Note: he runs a small factory of odd markets on a fast chain.", needles), ["profile line 3"]);
  assert.deepEqual(scan.findIn("Copied: Secret Line 7 Zebra.", needles), ["private line 8"]);
  assert.deepEqual(scan.findIn("see x/pool-that-lends-the-spare-part-of-its-liquidity-out.md", needles), []);
});

test("the marks count only where they are asked for", () => {
  assert.deepEqual(scan.findIn("these are plain words", needles), []);
  assert.deepEqual(scan.findIn("these are plain words", needles, { marks: true }), ["outreach mark 1"]);
});

test("the transform applies the replacements and points our commit ids at the rewrite", () => {
  const map = new Map([
    ["aaaaaaa1111111111111111111111111111111111".slice(0, 40), "bbbbbbb2222222222222222222222222222222222".slice(0, 40)],
    ["0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567"], // unchanged by the rewrite
    ["ccccccc3333333333333333333333333333333333".slice(0, 40), "ddddddd4444444444444444444444444444444444".slice(0, 40)],
  ]);
  const t = move.makeTransform([{ from: '"his exact words"', to: "what he asked for" }], map);
  assert.equal(t('He said "his exact words".'), "He said what he asked for.");
  assert.equal(t("merged as aaaaaaa1 and `ccccccc3`."), "merged as bbbbbbb2 and `ddddddd4`.");
  assert.equal(t(`full ${"a".repeat(7)}${"1".repeat(33)}`), `full ${"b".repeat(7)}${"2".repeat(33)}`);
  assert.equal(t("Pipeline at a2d5bfb and 0123456."), "Pipeline at a2d5bfb and 0123456."); // not ours, or unchanged
  assert.equal(t("a word like deadbee or 1234567 stays"), "a word like deadbee or 1234567 stays");
});

test("placeholders name the archive, the squash commit and the new number", () => {
  const map = new Map([["e".repeat(40), "f".repeat(40)]]);
  const merged = { number: 7, title: "Do a thing", merged: true, mergedAt: "2026-11-12T01:02:03Z", mergeCommit: { oid: "e".repeat(40) }, state: "MERGED" };
  const body = move.placeholderBody(merged, map, null, "2026-11-19");
  assert.match(body, /testing-pipeline-archive/);
  assert.match(body, new RegExp(`merged on 2026-11-12 as ${"f".repeat(40)} on \`main\` \\(\`eeeeeee\` in the archive\\)`));
  assert.equal(move.placeholderTitle(merged), "Archived pull request: Do a thing");
  const open = { number: 9, title: "Open one", merged: false, state: "OPEN", headRefName: "imDev2023/build-66" };
  assert.match(move.placeholderBody(open, map, 168, "2026-11-19"), /goes on as #168, on the same branch `imDev2023\/build-66`/);
  assert.equal(move.ticketOf({ closingIssuesReferences: { nodes: [] }, headRefName: "imDev2023/build-66" }), 66);
});

test("the map's links to moved pull requests get the new numbers, and only those", () => {
  const body = "in [#156](https://github.com/imDev2023/testing-pipeline/pull/156) and [x](https://github.com/imDev2023/testing-pipeline/pull/1566) and (https://github.com/imDev2023/testing-pipeline/pull/156)";
  assert.equal(
    move.remapPrs(body, { 156: 168 }),
    "in [#168](https://github.com/imDev2023/testing-pipeline/pull/168) and [x](https://github.com/imDev2023/testing-pipeline/pull/1566) and (https://github.com/imDev2023/testing-pipeline/pull/168)",
  );
});
