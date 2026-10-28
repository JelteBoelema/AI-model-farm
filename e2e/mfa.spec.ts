import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { E2E_ENV } from "../playwright.config";
import { hashPassword } from "../src/server/auth/password";
import { base32Decode, hotp, stepAt } from "../src/server/auth/totp";

const ADMIN = { email: "mfa-admin@e2e.local", password: "e2e-mfa-admin-password" };
const code = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), stepAt(new Date()) + offsetSteps);

test.beforeAll(async () => {
  const db = new PrismaClient({ datasourceUrl: E2E_ENV.DATABASE_URL });
  await db.user.upsert({ where: { email: ADMIN.email }, update: {}, create: { email: ADMIN.email, name: "Mia Admin", role: "ADMIN", passwordHash: await hashPassword(ADMIN.password) } });
  await db.$disconnect();
});

test("an admin sets up two-factor authentication and then signs in with a code", async ({ page, browser }) => {
  const res = await page.goto("/login");
  expect(res!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");

  await page.goto("/account/security");
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  const secret = (await page.getByLabel("Setup key").textContent())!.replace(/\s/g, "");
  await page.getByLabel("Code").fill(code(secret, -1));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);
  const recovery = await page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem").first().textContent();
  await page.getByRole("button", { name: "I have saved them" }).click();
  await expect(page).toHaveURL("/");

  // A new browser session: the password alone is not enough.
  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto("/login");
  await fresh.getByLabel("Email").fill(ADMIN.email);
  await fresh.getByLabel("Password").fill(ADMIN.password);
  await fresh.getByRole("button", { name: "Sign in" }).click();
  await fresh.getByLabel("Authentication code").fill("000000");
  await fresh.getByRole("button", { name: "Verify" }).click();
  await expect(fresh.getByText(/That code is not valid/)).toBeVisible();
  await fresh.getByLabel("Authentication code").fill(recovery!);
  await fresh.getByRole("button", { name: "Verify" }).click();
  await expect(fresh).toHaveURL("/");
  await expect(fresh.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});
