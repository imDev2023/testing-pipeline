// How a token is named and pictured (docs/spec/pipescope-screens.md, "Token names and images";
// PIPESCOPE-22, PIPESCOPE-82): by its own symbol in the author's style, always with its mint's short
// address, and its image 20 px square from Aviary's own copy; SOL and USDC by Aviary, plainly, with
// marks that ship with the app; a mint with no metadata by its short address alone.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MintLabel } from "@/components/MintLabel";
import { API_URL } from "@/config";

const MINT = "5AMPgS3baS6g4gsgSGwkE2wx9dV6iJNzaCMfpDFNfvM9";
const WSOL = "So11111111111111111111111111111111111111112";
const IMAGE = "ab".repeat(32);

const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const tagsOf = (html: string) => [...html.matchAll(/<([a-z][a-z0-9]*)\b/g)].map((m) => m[1]);

describe("a token that names itself", () => {
  it("is shown by its symbol in the author's style, its short address beside it, and its image from Aviary's own copy", () => {
    const html = renderToStaticMarkup(<MintLabel mint={MINT} symbol={null} token={{ symbol: "DREAM", name: "Pipe Dream", image: IMAGE }} />);
    expect(textOf(html)).toBe("DREAM 5AMP...fvM9");
    expect(html).toMatch(/<span class="[^"]*author[^"]*">DREAM<\/span>/);
    const img = html.match(/<img [^>]*>/)?.[0] ?? "";
    expect(img).toContain(`src="${API_URL}/images/${IMAGE}"`);
    expect(img).toContain('width="20"');
    expect(img).toContain('height="20"');
    expect(img).toContain('alt=""');
    expect(img).toContain('referrerPolicy="no-referrer"');
  });

  it("shows no image and no placeholder when it has none", () => {
    const html = renderToStaticMarkup(<MintLabel mint={MINT} symbol={null} token={{ symbol: "DREAM", name: "Pipe Dream", image: null }} />);
    expect(tagsOf(html).every((t) => t === "span")).toBe(true);
    expect(textOf(html)).toBe("DREAM 5AMP...fvM9");
  });

  it("is shown by its name when it gives no symbol", () => {
    expect(textOf(renderToStaticMarkup(<MintLabel mint={MINT} symbol={null} token={{ symbol: null, name: "Pipe Dream", image: null }} />))).toBe("Pipe Dream 5AMP...fvM9");
  });

  it("keeps markup in its symbol as the characters they are", () => {
    const html = renderToStaticMarkup(<MintLabel mint={MINT} symbol={null} token={{ symbol: "<b>SOL</b>", name: null, image: null }} />);
    expect(tagsOf(html).every((t) => t === "span")).toBe(true);
    expect(textOf(html)).toBe("<b>SOL</b> 5AMP...fvM9");
  });
});

describe("a mint Aviary names", () => {
  it("is shown by Aviary's name, plainly, with the mark that ships with the app and no author's style", () => {
    const html = renderToStaticMarkup(<MintLabel mint={WSOL} symbol="SOL" token={null} />);
    expect(textOf(html)).toBe("SOL");
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/author/);
    expect(html).not.toContain("<img");
  });
});

describe("a mint with no metadata", () => {
  it("is shown by its short address alone", () => {
    const html = renderToStaticMarkup(<MintLabel mint={MINT} symbol={null} token={null} />);
    expect(textOf(html)).toBe("5AMP...fvM9");
    expect(html).not.toMatch(/author|<img|<svg/);
  });
});
