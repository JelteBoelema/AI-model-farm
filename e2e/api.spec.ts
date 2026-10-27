import { expect, test } from "@playwright/test";

test("readiness probe reports dependencies without leaking details", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(Object.keys(body.checks).sort()).toEqual(["database", "redis", "storage"]);
  expect(JSON.stringify(body)).not.toMatch(/postgres|redis:\/\/|password/i);
});

test("media endpoint requires authentication", async ({ request }) => {
  const res = await request.get("/api/media/shared/x/2026/01/a.png");
  expect(res.status()).toBe(401);
});

test("security headers are set", async ({ request }) => {
  const res = await request.get("/login");
  const h = res.headers();
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["x-powered-by"]).toBeUndefined();
});
