import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("owner tightens and loosens a farm-wide limit; the change is audited", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/settings/autonomy");
  await expect(page.getByRole("heading", { name: "Autopilot" })).toBeVisible();

  const posts = page.getByLabel("Posts per account per day");
  const before = await posts.inputValue();
  await posts.fill("1");
  await page.getByLabel("Reason (shown to the owner)").fill("quiet week");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Limits saved")).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByText("Posts per day").locator("xpath=following-sibling::dd[1]")).toHaveText("1");

  // Loosening again: the owner applies it directly (recorded as an approved change).
  await page.goto("/settings/autonomy");
  await page.getByLabel("Posts per account per day").fill(before || "3");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Limits saved")).toBeVisible();

  await page.goto("/settings/approvals");
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(page.getByText("Looser limits:").first()).toBeVisible();

  await page.goto("/settings/audit?q=policy.");
  await expect(page.getByRole("cell", { name: "policy.changed" }).first()).toBeVisible();
});

test("a viewer sees the limits but cannot change them", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/settings/autonomy");
  await expect(page.getByLabel("Posts per account per day")).toBeDisabled();
  await expect(page.getByRole("button", { name: /Save limits|Save or request/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run planning now" })).toHaveCount(0);
});
