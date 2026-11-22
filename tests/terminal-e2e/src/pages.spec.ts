// Every page this ticket adds, at 1440, 390 and 360 px in the light and the dark theme
// (PIPESCOPE-96): it wears the shell, nothing scrolls sideways, it requests nothing from any origin but
// Aviary's own, fonts included, and its screenshot is saved for the PR.
import { expect, test, type Page } from "@playwright/test";
import { screenshot } from "./screenshot";
import { OWN_ORIGINS } from "./target";

const UNKNOWN_ADDRESS = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";

const PAGES = [
  { name: "feed", path: "/", status: 200, ready: (page: Page) => expect(page.getByText("Latest slot")).toBeVisible() },
  { name: "devnet-help", path: "/devnet", status: 200, ready: (page: Page) => expect(page.getByRole("heading", { name: "Get devnet USDC" })).toBeVisible() },
  { name: "nothing-there", path: `/markets/${UNKNOWN_ADDRESS}`, status: 404, ready: (page: Page) => expect(page.getByText(UNKNOWN_ADDRESS)).toBeVisible() },
  { name: "no-page", path: "/no-such-page", status: 404, ready: (page: Page) => expect(page.getByRole("heading", { name: "No page here" })).toBeVisible() },
];

for (const { name, path, status, ready } of PAGES) {
  test(`${name} wears the shell, stays inside the window and calls only Aviary's own origins`, async ({ page }, testInfo) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));

    const response = await page.goto(path);
    expect(response?.status()).toBe(status);
    await ready(page);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    // The header: the name, linking to the feed, and the devnet tag.
    const header = page.getByRole("banner");
    const brand = header.getByRole("link").filter({ hasNotText: "Skip to the page" }).first();
    await expect(brand).toHaveAttribute("href", "/");
    await expect(brand).not.toHaveText("");
    await expect(header.getByText("devnet", { exact: true })).toBeVisible();

    // The footer: the three styles of "Who is speaking", the devnet line, Devnet help and the theme control.
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByText(/^Plain text was read from the chain or measured by /)).toBeVisible();
    await expect(footer.getByText("Text set like this was written by an AI from those facts.")).toBeVisible();
    await expect(footer.getByText("Text like this was written by a strategy's or token's author and is not verified.")).toBeVisible();
    await expect(footer.getByText(/^Devnet only\. .+ never holds your keys: every transaction is signed in your own wallet, after a simulation you see first\.$/)).toBeVisible();
    await expect(footer.getByRole("link", { name: "Devnet help" })).toBeVisible();
    await expect(footer.getByRole("radio")).toHaveCount(3);

    // Nothing scrolls sideways at any width down to 360 px.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);

    // Every request went to Aviary's own origins, and both typefaces came from there and loaded.
    const foreign = requested.filter((url) => !url.startsWith("data:") && !OWN_ORIGINS.includes(new URL(url).origin));
    expect(foreign).toEqual([]);
    const fonts = requested.filter((url) => url.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
    const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")));
    expect(loaded).toEqual(expect.arrayContaining(["Archivo", "Literata"]));

    await screenshot(page, testInfo, name);
  });
}
