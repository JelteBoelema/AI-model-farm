import { expect, test } from "@playwright/test";
import { login, OWNER } from "./helpers";

const SECTIONS = [
  ["/", "Overview"],
  ["/creators", "Creators"],
  ["/characters", "Character Studio"],
  ["/prompts", "Prompt Studio"],
  ["/content", "Content Factory"],
  ["/media", "Media Library"],
  ["/calendar", "Content Calendar"],
  ["/campaigns", "Campaigns"],
  ["/social", "Social Accounts"],
  ["/analytics", "Analytics"],
  ["/costs", "Costs & Budgets"],
  ["/providers", "AI Providers"],
  ["/workflows", "Workflow Monitor"],
  ["/settings", "Settings & Audit"],
] as const;

test("all 14 sections render without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await login(page, OWNER);
  for (const [path, title] of SECTIONS) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("sidebar navigation keeps global filters", async ({ page }) => {
  await login(page, OWNER);
  await page.getByLabel("Period").selectOption("7d");
  await expect(page).toHaveURL(/period=7d/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Content Factory" }).click();
  await expect(page).toHaveURL(/\/content\?period=7d/);
});

test("demo data is labelled as demo, never as measured", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/analytics");
  // With only demo data, the page opens on the demo tab and says so.
  await expect(page.getByRole("navigation", { name: "Data origin" }).getByRole("link", { name: /Demo/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("note").getByText("Seeded demonstration data")).toBeVisible();
  await expect(page.getByLabel("Measured totals")).toHaveCount(0);
  await page.goto("/creators");
  await expect(page.getByText("Demo", { exact: true }).first()).toBeVisible();
});
