import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("idea → brief → shot list → caption → image → QC → approval in mock mode", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, OWNER);
  await page.goto("/content");
  await page.getByRole("button", { name: "New content" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Creator").selectOption({ label: "Lena Studio" });
  await dialog.getByLabel("Format").selectOption({ label: "Carousel" });
  await dialog.getByLabel("Slides").fill("2");
  await dialog.getByLabel("Title").fill("Layering for rainy days");
  await dialog.getByLabel("Idea").fill("Two outfits that survive an autumn shower");
  await expect(dialog.getByLabel("Start production now")).toBeChecked();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await page.waitForURL(/\/content\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Layering for rainy days" })).toBeVisible();
  // The worker runs every step; the page refreshes itself until quality control is done.
  const qc = page.getByLabel("Quality control");
  await expect(qc.getByText("Passed")).toBeVisible({ timeout: 45_000 });
  const pipeline = page.getByLabel("Pipeline");
  for (const step of ["Brief", "Shot list", "Caption", "Images", "Quality control"]) await expect(pipeline.locator('li[data-state="done"]', { hasText: step })).toBeVisible();
  await expect(page.getByText(/Made with AI/).first()).toBeVisible();

  const shots = page.getByLabel("Shots");
  await expect(shots.getByRole("img")).toHaveCount(2);
  await expect.poll(() => shots.getByRole("img").first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(shots.getByText("Mock", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "€0 (mock)" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Approve content" }).click();
  await expect(page.getByText("Content approved")).toBeVisible();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(shots.getByText("Approved", { exact: true })).toHaveCount(2);

  // The approved takes are in the media library and can be compared side by side.
  await page.goto("/media?status=APPROVED");
  const tiles = page.getByRole("figure").filter({ hasText: "Layering for rainy days" });
  await expect(tiles).toHaveCount(2);
  await tiles.nth(0).getByText("Compare").click();
  await tiles.nth(1).getByText("Compare").click();
  await page.getByRole("link", { name: "Compare" }).click();
  await expect(page.getByLabel("Asset 1")).toBeVisible();
  await expect(page.getByLabel("Asset 2").getByText("Real provider output")).toBeVisible();
});

test("batch of ideas creates one item per line", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/content");
  await page.getByRole("button", { name: "New batch" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Creator").selectOption({ label: "Milo Moves" });
  await dialog.getByLabel("Batch name").fill("Mobility week");
  await dialog.getByLabel("Ideas").fill("Desk stretch\nStairs workout\nEvening walk");
  await dialog.getByLabel("Start production now").uncheck();
  await dialog.getByRole("button", { name: "Create batch" }).click();
  await page.waitForURL(/\/content\?batch=/);
  await expect(page.getByText(/^Batch Mobility week/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Desk stretch|Stairs workout|Evening walk/ })).toHaveCount(3);
});

test("viewer sees the factory read-only", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/content");
  await expect(page.getByRole("heading", { name: "Content Factory" })).toBeVisible();
  await expect(page.getByRole("button", { name: /New content|New batch/ })).toHaveCount(0);
});
