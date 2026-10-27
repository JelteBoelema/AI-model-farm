import { expect, type Page } from "@playwright/test";

export const OWNER = { email: "owner@e2e.local", password: "e2e-owner-password" };
export const VIEWER = { email: "viewer@e2e.local", password: "e2e-viewer-password" };

export async function login(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  // Start from a fresh, fully hydrated page so tests never race the post-login redirect.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}
