import { expect, test } from "@playwright/test";
import { login, OWNER, VIEWER } from "./helpers";

test("connect a mock Instagram account, publish approved content and see it in the mock feed and calendar", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, OWNER);

  // 1. Connect through the (mock) OAuth consent screen. The owner's own link needs no further approval.
  await page.goto("/social");
  await page.getByRole("button", { name: "Connect Instagram" }).click();
  await page.getByRole("dialog").getByLabel("Creator").selectOption({ label: "Lena Studio" });
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/social\/mock-authorize\?/);
  await page.getByLabel("Mock account handle").fill("lena.e2e");
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/\/social\?connected=/);
  await expect(page.getByRole("status").getByText("@lena.e2e connected")).toBeVisible();
  const card = page.getByLabel("@lena.e2e", { exact: true });
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card.getByText("Mock", { exact: true })).toBeVisible();
  await expect(card.getByLabel("@lena.e2e capabilities").getByText("Image post")).toBeVisible();

  // 2. Produce and approve an image post.
  await page.goto("/content");
  await page.getByRole("button", { name: "New content" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Creator").selectOption({ label: "Lena Studio" });
  await dialog.getByLabel("Title").fill("First post on the mock feed");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/content\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Quality control").getByText("Passed")).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Approve content" }).click();
  await expect(page.getByText("Content approved")).toBeVisible();
  const itemId = page.url().split("/").at(-1)!;

  // 3. Publish now; the publishing worker posts to the mock platform.
  const publishing = page.getByLabel("Publishing", { exact: true });
  await publishing.getByLabel("Account").selectOption({ label: "@lena.e2e (mock)" });
  await publishing.getByRole("button", { name: "Publish now" }).click();
  const row = publishing.getByLabel("Publications").getByRole("listitem").filter({ hasText: "@lena.e2e" });
  await expect(row.getByText("Published", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();

  // 4. The mock feed shows the post; nothing went to a real platform.
  await row.getByRole("link", { name: "View post" }).click();
  await page.waitForURL(/\/social\/mock-feed\//);
  const post = page.getByLabel("Mock post").filter({ hasText: "First post on the mock feed" });
  await expect(post).toBeVisible();
  await expect(post.getByText("Made with AI")).toBeVisible();

  // 5. The calendar's day view lists it, in the chosen time zone.
  await page.goto("/calendar?view=day");
  await expect(page.getByLabel("Day").getByText("First post on the mock feed")).toBeVisible();

  // 6. The export package (manual alternative) is a ZIP marked as mock.
  const pkg = await page.request.get(`/api/content/${itemId}/export`);
  expect(pkg.status()).toBe(200);
  expect(pkg.headers()["content-type"]).toBe("application/zip");
  expect(pkg.headers()["content-disposition"]).toMatch(/-MOCK\.zip"$/);
});

test("calendar views and campaign management", async ({ page }) => {
  await login(page, OWNER);
  await page.goto("/calendar?view=month");
  await expect(page.getByRole("grid", { name: "Month" })).toBeVisible();
  await page.getByRole("link", { name: "week", exact: true }).click();
  await expect(page.getByLabel("Week")).toBeVisible();
  await page.getByLabel("Time zone").selectOption("UTC");
  await expect(page).toHaveURL(/tz=UTC/);

  await page.goto("/campaigns");
  await page.getByRole("button", { name: "New campaign" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Winter capsule");
  await dialog.getByLabel("Objective").fill("Grow saves on outfit posts");
  await dialog.getByLabel("Lena Studio").check();
  await dialog.getByRole("button", { name: "Create campaign" }).click();
  await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Winter capsule" })).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("Campaign activated")).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText(/Paused: generation and publishing/)).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Campaign resumed")).toBeVisible();
  await page.getByLabel("Limit (EUR)").fill("120");
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByText("Budget saved")).toBeVisible();
  await expect(page.getByText(/of €\s120,00 monthly budget/)).toBeVisible();
});

test("viewers cannot connect accounts or schedule", async ({ page }) => {
  await login(page, VIEWER);
  await page.goto("/social");
  await expect(page.getByRole("button", { name: "Connect Instagram" })).toHaveCount(0);
  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: "Plan in bulk" })).toHaveCount(0);
  await page.goto("/campaigns");
  await expect(page.getByRole("button", { name: "New campaign" })).toHaveCount(0);
});
