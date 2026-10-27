import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertValidKey, buildStorageKey, LocalStorageDriver } from "@/server/storage";

describe("storage keys", () => {
  it("builds partitioned keys", () => {
    const key = buildStorageKey({ creatorId: "ABC", kind: "images", id: "XYZ", extension: ".PNG" }, new Date("2026-03-05T00:00:00Z"));
    expect(key).toBe("creators/abc/images/2026/03/xyz.png");
  });

  it("rejects traversal and odd characters", () => {
    for (const bad of ["../etc/passwd", "a/../../b", "/abs", "a//b", "A B", "x\u0000y"]) expect(() => assertValidKey(bad)).toThrow();
  });
});

describe("local storage driver", () => {
  let dir: string;
  afterAll(async () => dir && rm(dir, { recursive: true, force: true }));

  it("stores, checksums, reads and never overwrites", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cf-storage-"));
    const driver = new LocalStorageDriver(dir);
    const obj = await driver.put("shared/test/2026/01/a.txt", Buffer.from("hello"), "text/plain");
    expect(obj.checksumSha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect((await driver.get(obj.key)).toString()).toBe("hello");
    await expect(driver.put(obj.key, Buffer.from("other"), "text/plain")).rejects.toThrow();
    expect(await driver.exists(obj.key)).toBe(true);
    await driver.delete(obj.key);
    expect(await driver.exists(obj.key)).toBe(false);
    await expect(driver.healthCheck()).resolves.toBeUndefined();
  });
});
