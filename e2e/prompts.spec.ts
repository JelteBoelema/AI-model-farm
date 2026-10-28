import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("template → validate → test → publish → new version with diff → pin → deprecate", async ({ page }) => {
  test.setTimeout(90_000);
  const key = `e2e.caption.${Date.now() % 100000}`;
  await login(page, OWNER);

  await page.goto("/prompts");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New template" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Key").fill(key);
  await dialog.getByLabel("Name").fill("E2E caption");
  await dialog.getByLabel("Kind").selectOption("CAPTION");
  await dialog.getByRole("button", { name: "Create template" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "E2E caption" })).toBeVisible();

  // Undeclared variable is reported, declaring it fixes the draft
  await page.getByLabel("Template body").fill("Caption for {{creator_name}} about {{topic}}.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText('Variable "topic" is used but not declared')).toBeVisible();
  await page.getByRole("button", { name: "Add variable" }).click();
  await page.getByLabel("Variable 1 name").fill("topic");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("No problems found. This version can be published.")).toBeVisible();

  // Test with real creator context
  await page.reload();
  await page.getByLabel("Creator context").selectOption({ label: "Milo Moves" });
  await page.getByLabel("topic", { exact: true }).fill("morning mobility");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByLabel("Rendered prompt")).toHaveText("Caption for Milo Moves about morning mobility.");
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByText("Test run queued")).toBeVisible();
  // executed by the generation worker; the panel refreshes until it completes
  const comparison = page.getByLabel("Comparison");
  await expect(comparison.getByText(/\[Mock caption output/)).toBeVisible({ timeout: 20_000 });

  // Publish v1
  await page.getByRole("button", { name: "Publish v1" }).click();
  await page.getByLabel("Changelog").fill("First version");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Changelog: First version")).toBeVisible();
  await expect(page.getByLabel("Template body")).toHaveText("Caption for {{creator_name}} about {{topic}}.");

  // v2 with a diff
  await page.getByRole("button", { name: "New draft version" }).click();
  await expect(page.getByRole("heading", { name: "Version 2" })).toBeVisible();
  await page.getByLabel("Template body").fill("Short caption for {{creator_name}} about {{topic}}.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("No problems found. This version can be published.")).toBeVisible();
  await page.reload();
  const diff = page.getByLabel("Version diff");
  await expect(diff.getByText("- Caption for {{creator_name}} about {{topic}}.")).toBeVisible();
  await expect(diff.getByText("+ Short caption for {{creator_name}} about {{topic}}.")).toBeVisible();
  await page.getByRole("button", { name: "Publish v2" }).click();
  await page.getByLabel("Changelog").fill("Shorter");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Changelog: Shorter")).toBeVisible();

  // Pin v1 to the demo campaign; deprecation is refused while pinned
  await page.getByRole("link", { name: /^v1/ }).click();
  await expect(page.getByText("Changelog: First version")).toBeVisible();
  await page.getByLabel("Campaign to pin").selectOption({ label: "Autumn Wardrobe (demo)" });
  await page.getByRole("button", { name: "Pin this version" }).click();
  await expect(page.getByText("Pinned to campaign")).toBeVisible();
  await page.getByRole("button", { name: "Deprecate" }).click();
  await expect(page.getByText(/Pinned by open campaign/)).toBeVisible();
  await page.getByRole("button", { name: "Unpin" }).click();
  await expect(page.getByText("Not pinned by any campaign.")).toBeVisible();
  await page.getByRole("button", { name: "Deprecate" }).click();
  await expect(page.getByText("Version deprecated")).toBeVisible();
  await expect(page.getByText("Deprecated versions cannot be tested.")).toBeVisible();

  await page.goto("/settings/audit?q=prompt.");
  for (const action of ["prompt.template_created", "prompt.test_run", "prompt.published", "prompt.pinned", "prompt.unpinned", "prompt.deprecated"])
    await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
});

test("viewer sees prompts read-only", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/prompts");
  await expect(page.getByRole("button", { name: "New template" })).toHaveCount(0);
  await page.getByRole("link", { name: "Caption", exact: true }).click();
  await expect(page.getByText("Testing unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: /Publish|Deprecate|New draft/ })).toHaveCount(0);
});
