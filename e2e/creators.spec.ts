import path from "node:path";
import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

const FIXTURE = path.join(__dirname, "../tests/fixtures/ref-600.png");

test("brief → proposal → creator → character → activate → pause/resume → duplicate → archive", async ({ page }) => {
  test.setTimeout(90_000);
  const name = `Iris E2E ${Date.now() % 100000}`;
  await login(page, OWNER);

  // Wizard
  await page.goto("/creators");
  await page.getByRole("link", { name: "New creator" }).click();
  await page.getByLabel("Brief", { exact: true }).fill("A Dutch creator about quick plant-based recipes for students on a budget.");
  await page.getByRole("button", { name: "Propose profile" }).click();
  await expect(page.getByText("Proposal from mock-text")).toBeVisible();
  await expect(page.getByText("Mock", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("Approve a character profile to activate")).toBeVisible();

  // Activation is refused without an approved identity
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText(/Approve a character profile before activating/)).toBeVisible();

  // Edit profile
  await page.getByLabel("Niche", { exact: true }).fill("Budget plant-based cooking");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Niche", { exact: true })).toHaveValue("Budget plant-based cooking");

  // Budget
  await page.getByLabel("Monthly limit (EUR)").fill("100");
  await page.getByRole("button", { name: "Save monthly limit" }).click();
  await expect(page.getByText("Budget saved")).toBeVisible();

  // Character Studio: draft v1 from the wizard, add reference, approve
  await page.getByRole("link", { name: "Open Character Studio" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Character Studio · ${name}` })).toBeVisible();
  await page.getByLabel("Image", { exact: true }).setInputFiles(FIXTURE);
  await page.getByLabel("Label", { exact: true }).fill("front, neutral light");
  await page.getByLabel("Source & rights").fill("Generated placeholder for e2e tests");
  await page.getByRole("button", { name: "Upload reference" }).click();
  await expect(page.getByRole("img", { name: "front, neutral light" })).toBeVisible();
  // the uploaded image is served (authenticated) and decodes
  await expect.poll(() => page.getByRole("img", { name: "front, neutral light" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(600);

  await page.getByRole("button", { name: "Approve version 1" }).click();
  await page.getByLabel("Likeness attestation").fill("Synthetic identity created for e2e tests, not based on a real person.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Version 1 approved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload reference" })).toHaveCount(0); // immutable now

  // Activate, pause, resume
  await page.getByRole("link", { name: "Creator profile" }).click();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("Creator activated")).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();

  // Duplicate, then archive the copy
  await page.getByRole("button", { name: "Duplicate" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${name} (copy)` })).toBeVisible();
  await page.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("button", { name: "Archive creator" }).click();
  await expect(page.getByText("Archived creators are read-only.")).toBeVisible();
  await expect(page.getByLabel("Niche", { exact: true })).toBeDisabled();

  // Everything is in the audit log
  await page.goto("/settings/audit?q=creator.");
  for (const action of ["creator.created", "creator.activated", "creator.paused", "creator.resumed", "creator.duplicated", "creator.archived"]) {
    await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
  }
});

test("viewer sees creators read-only", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/creators");
  await expect(page.getByRole("link", { name: "New creator" })).toHaveCount(0);
  await page.getByRole("link", { name: "Milo Moves" }).click();
  await expect(page.getByLabel("Niche", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save profile" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await page.goto("/creators/new");
  await expect(page.getByText("Access denied")).toBeVisible();
});
