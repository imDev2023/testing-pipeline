import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { rawStyles } from "./rawStyles";

// Every colour and typeface comes from the theme stylesheet (PIPESCOPE-85,
// docs/spec/pipescope-screens.md, "One place for every value"): no component writes its own.
const SRC = join(import.meta.dirname, "..", "src");
const THEME = join(SRC, "theme.css");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && path !== THEME ? [path] : [];
  });
}

describe("the theme guard", () => {
  it("finds no colour and no typeface written outside src/theme.css", () => {
    const found = sources(SRC).flatMap((path) => rawStyles(path, readFileSync(path, "utf8")).map((hit) => `${relative(SRC, path)}: ${hit}`));
    expect(found).toEqual([]);
  });

  it("catches colours written in a stylesheet", () => {
    expect(rawStyles("a.module.css", ".a { color: #13222c; }")).toHaveLength(1);
    expect(rawStyles("a.module.css", ".a { background: rgb(0 0 0 / 50%); }")).toHaveLength(1);
    expect(rawStyles("a.module.css", ".a { border: 1px solid green; }")).toHaveLength(1);
    expect(rawStyles("a.module.css", ".a { box-shadow: 0 0 0 2px oklch(70% 0.1 200); }")).toHaveLength(1);
    expect(rawStyles("a.module.css", ".a { outline-color: Red; }")).toHaveLength(1);
  });

  it("catches typefaces written in a stylesheet", () => {
    expect(rawStyles("a.module.css", ".a { font-family: Georgia, serif; }")).toHaveLength(1);
    expect(rawStyles("a.module.css", ".a { font: italic 14px/1.5 Arial; }")).toHaveLength(1);
    expect(rawStyles("a.module.css", "@font-face { font-family: X; src: url(x.woff2); }")).not.toHaveLength(0);
  });

  it("catches colours and typefaces written in a component", () => {
    expect(rawStyles("A.tsx", `<p style={{ color: "white" }} />`)).toHaveLength(1);
    expect(rawStyles("A.tsx", `<p style={{ backgroundColor: "#fff" }} />`)).toHaveLength(1);
    expect(rawStyles("A.tsx", `<svg><path fill="#FFD60A" /></svg>`)).toHaveLength(1);
    expect(rawStyles("A.tsx", `<p style={{ fontFamily: "Literata" }} />`)).toHaveLength(1);
    expect(rawStyles("A.tsx", "const shade = `hsl(200 10% 10%)`;")).toHaveLength(1);
    expect(rawStyles("a.ts", "export const ground = '#0e1920';")).toHaveLength(1);
  });

  it("lets components use the theme's tokens", () => {
    expect(rawStyles("a.module.css", ".a { color: var(--ink2); border: 1px solid var(--rule); font-family: var(--font-serif); }")).toEqual([]);
    expect(rawStyles("a.module.css", ".a { background: transparent; fill: currentColor; color: inherit; font: inherit; }")).toEqual([]);
    expect(rawStyles("A.tsx", `<svg><path fill="currentColor" stroke="none" /></svg>`)).toEqual([]);
    expect(rawStyles("A.tsx", `<a href="#main">Skip</a>`)).toEqual([]);
    expect(rawStyles("A.tsx", "// Until the indexer lands (#116) it shows Aviary's connection.\n<p>It&apos;s here</p>")).toEqual([]);
    expect(rawStyles("A.tsx", `<p style={{ color: "var(--author)" }} />`)).toEqual([]);
  });
});
