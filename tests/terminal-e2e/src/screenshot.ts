import type { Page, TestInfo } from "@playwright/test";

/** Saves the whole page as screenshots/<width>-<theme>/<name>.png, and attaches it to the report. */
export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = `${import.meta.dirname}/../screenshots/${testInfo.project.name}/${name}.png`;
  const body = await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { body, contentType: "image/png" });
}
