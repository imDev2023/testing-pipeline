// What every page of Aviary wears and keeps to (PIPESCOPE-96), checked on each page by the local
// run's suite (src/pages.spec.ts) and on the hosted deployment (src/deployed.spec.ts): the header
// and the footer, nothing scrolling sideways, every request to Aviary's own origins with both
// typefaces from there, and the screens' rule about colour.
import { expect, type Page } from "@playwright/test";

/** Checks the page, loaded and ready, against the shell; `requested` is every URL it asked for, and `ownOrigins` Aviary's own. */
export async function expectShell(page: Page, requested: string[], ownOrigins: string[]): Promise<void> {
  // The header: the name, linking to the feed, and the devnet tag.
  const header = page.getByRole("banner");
  const brand = header.getByRole("link").filter({ hasNotText: "Skip to the page" }).first();
  await expect(brand).toHaveAttribute("href", "/");
  await expect(brand).not.toHaveText("");
  await expect(header.getByText("devnet", { exact: true })).toBeVisible();
  await expect(header.getByRole("searchbox", { name: "Search" })).toBeVisible();

  // The header's wallet button.
  await expect(header.getByRole("button", { name: /^(Connect wallet|E69P\.\.\.JnAW)$/ })).toBeVisible();

  // The footer: the three styles of "Who is speaking", the devnet line, Fees, Devnet help and the theme control.
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByText(/^Plain text was read from the chain or measured by /)).toBeVisible();
  await expect(footer.getByText("Text set like this was written by an AI from those facts.")).toBeVisible();
  await expect(footer.getByText("Text like this was written by a strategy's or token's author and is not verified.")).toBeVisible();
  await expect(footer.getByText(/^Devnet only\. .+ never holds your keys: every transaction is signed in your own wallet, after a simulation you see first\.$/)).toBeVisible();
  await expect(footer.getByRole("link", { name: "Fees" })).toHaveAttribute("href", "/fees");
  await expect(footer.getByRole("link", { name: "Devnet help" })).toBeVisible();
  await expect(footer.getByRole("link", { name: "Keeper" })).toHaveAttribute("href", "/keeper");
  await expect(footer.getByRole("radio")).toHaveCount(3);

  // Nothing scrolls sideways at any width down to 360 px.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);

  // Every request went to Aviary's own origins, and both typefaces came from there and loaded.
  const foreign = requested.filter((url) => !url.startsWith("data:") && !ownOrigins.includes(new URL(url).origin));
  expect(foreign).toEqual([]);
  const fonts = requested.filter((url) => url.endsWith(".woff2"));
  expect(fonts.length).toBeGreaterThan(0);
  const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")));
  expect(loaded).toEqual(expect.arrayContaining(["Archivo", "Literata"]));

  // Canary yellow only on Canary's mark beside its heading and on the trade box's notice, and nothing
  // green or red, in any element's computed colours (docs/spec/pipescope-screens.md, Colour and theme).
  expect(await colourViolations(page)).toEqual([]);
}

/**
 * Every computed colour on the page that breaks the screens' rule about colour: canary yellow outside
 * Canary's mark and the trade box's notice, a Canary mark or notice anywhere else, and anything green
 * or red. Each element and its ::before and ::after are read: text, backgrounds and their gradients,
 * borders, outlines, SVG fills and strokes, and decorations.
 */
export function colourViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const PROPS = ["color", "background-color", "background-image", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "text-decoration-color", "column-rule-color", "box-shadow"];
    const found: string[] = [];
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/)[0]}` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    /** Each rgb() or rgba() colour in a computed value, as red, green, blue and alpha. */
    const colours = (value: string) => [...value.matchAll(/rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)/g)].map((m) => ({ r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] }));
    const hsl = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const [R, G, B] = [r / 255, g / 255, b / 255];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0, l };
      const s = d / (1 - Math.abs(2 * l - 1));
      const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
      return { h: (h + 360) % 360, s, l };
    };
    const isCanary = (c: { r: number; g: number; b: number }) => c.r >= 245 && c.g >= 200 && c.g <= 225 && c.b <= 40;
    const isGreenOrRed = (c: { r: number; g: number; b: number }) => {
      const { h, s, l } = hsl(c);
      return s >= 0.25 && l >= 0.12 && l <= 0.88 && (h < 20 || h > 340 || (h > 75 && h < 165));
    };
    for (const el of document.querySelectorAll("body *")) {
      const inCanary = el.closest("[data-canary]") !== null;
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(el, pseudo);
        if (pseudo && (style.content === "none" || style.content === "normal")) continue;
        if (style.display === "none" || style.visibility === "hidden") continue;
        for (const prop of PROPS) {
          for (const c of colours(style.getPropertyValue(prop))) {
            if (c.a === 0) continue;
            if (isCanary(c) && !inCanary) found.push(`canary yellow in ${prop} of ${describe(el)}${pseudo ?? ""}`);
            else if (!isCanary(c) && isGreenOrRed(c)) found.push(`green or red rgb(${c.r}, ${c.g}, ${c.b}) in ${prop} of ${describe(el)}${pseudo ?? ""}`);
          }
        }
      }
    }
    // Canary's marks sit in a heading, and its notice in the trade box, nowhere else.
    for (const el of document.querySelectorAll('[data-canary="mark"]')) if (!el.closest("h1, h2, h3, h4")) found.push(`a Canary mark outside a heading: ${describe(el)}`);
    for (const el of document.querySelectorAll('[data-canary="notice"]')) if (!el.closest('section[aria-labelledby]')?.querySelector("h2")?.textContent?.includes("Swap")) found.push(`a Canary notice outside the trade box: ${describe(el)}`);
    for (const el of document.querySelectorAll("[data-canary]")) if (!["mark", "notice"].includes(el.getAttribute("data-canary") ?? "")) found.push(`an unknown Canary element: ${describe(el)}`);
    return found;
  });
}
