import { expect, test } from "@playwright/test";
import { login, OWNER } from "./helpers";

test("redirects anonymous users to sign-in", async ({ page }) => {
  await page.goto("/costs");
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);
});

test("shows a generic error for wrong credentials", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Invalid email or password.");
});

test("signs in and out, both audited", async ({ page }) => {
  await login(page, OWNER);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await login(page, OWNER);
  await page.goto("/settings/audit?q=auth.");
  await expect(page.getByRole("cell", { name: "auth.logout" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "auth.login_failed" }).first()).toBeVisible();
});
