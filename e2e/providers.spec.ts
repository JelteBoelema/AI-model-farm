import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("image prompt test produces a watermarked mock image via the worker", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, OWNER);
  await page.goto("/prompts");
  await page.getByRole("link", { name: "Lifestyle photo" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Creator context").selectOption({ label: "Lena Studio" });
  await page.getByLabel("Scene", { exact: true }).fill("reading in a sunny cafe");
  await page.getByRole("button", { name: "Run test" }).click();
  const image = page.getByLabel("Comparison").getByRole("img");
  await expect(image).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByLabel("Comparison").getByText("Mock", { exact: true })).toBeVisible();

  // the generated image is in the media library, labelled as mock
  await page.goto("/media");
  await expect(page.getByRole("cell", { name: /Generated · mock-image/ }).first()).toBeVisible();
});

test("admin manages a provider's price list; readiness reflects it", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/providers");
  const claude = page.getByLabel("Anthropic Claude", { exact: true });
  await expect(claude.getByText("Not configured")).toBeVisible();
  await expect(page.getByLabel("Mock text provider", { exact: true }).getByText("Active")).toBeVisible();

  await claude.getByRole("button", { name: "Prices" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Use preset" }).click();
  await dialog.getByLabel("EUR per USD").fill("0.95");
  await dialog.getByRole("button", { name: "Save price list" }).click();
  await expect(page.getByText("Price list saved")).toBeVisible();
  await expect(claude.getByText(/claude-opus-5-5 input_mtok 4\.00/)).toBeVisible();
  const readiness = page.getByLabel("Anthropic Claude readiness");
  await expect(readiness.getByText("Price list")).not.toHaveClass(/text-muted-foreground/);

  // without a real key the connection test fails and the provider stays unused
  await claude.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Secret not configured|Connection test failed|not set/).first()).toBeVisible();
  await expect(claude.getByText("Not configured")).toBeVisible();
});

test("viewer cannot change providers", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/providers");
  await expect(page.getByRole("button", { name: /Configure|Prices|Test connection/ })).toHaveCount(0);
});
