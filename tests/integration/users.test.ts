import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { verifyPassword } from "@/server/auth/password";
import { changeRole, createUser, setUserDisabled, UserServiceError } from "@/server/services/users";
import { makeUser, uid } from "./helpers";

const actorFor = (u: { id: string; role: "OWNER" | "ADMIN" | "OPERATOR" | "VIEWER"; email: string }) => ({ id: u.id, role: u.role, actor: { type: "USER" as const, id: u.id, label: u.email } });

describe("user management", () => {
  it("lets the owner create users with hashed passwords and audit trail", async () => {
    const owner = await makeUser("OWNER");
    const created = await createUser(actorFor(owner), { email: `New-${uid()}@Test.local`, name: "New", role: "OPERATOR", password: "a-long-enough-password" });
    const row = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.email).toBe(row.email.toLowerCase());
    expect(row.passwordHash).not.toContain("a-long-enough-password");
    expect(await verifyPassword("a-long-enough-password", row.passwordHash)).toBe(true);
    expect(await db.auditLog.findFirst({ where: { action: "user.created", entityId: created.id, actorId: owner.id } })).not.toBeNull();
  });

  it("enforces password length and unique emails", async () => {
    const owner = await makeUser("OWNER");
    await expect(createUser(actorFor(owner), { email: `x-${uid()}@test.local`, name: "x", role: "VIEWER", password: "short" })).rejects.toThrow();
    const email = `dup-${uid()}@test.local`;
    await createUser(actorFor(owner), { email, name: "x", role: "VIEWER", password: "a-long-enough-password" });
    await expect(createUser(actorFor(owner), { email, name: "x", role: "VIEWER", password: "a-long-enough-password" })).rejects.toBeInstanceOf(UserServiceError);
  });

  it("prevents non-owners from assigning roles", async () => {
    const admin = await makeUser("ADMIN");
    await expect(createUser(actorFor(admin), { email: `y-${uid()}@test.local`, name: "y", role: "VIEWER", password: "a-long-enough-password" })).rejects.toBeInstanceOf(UserServiceError);
  });

  it("protects the last active owner and the acting user", async () => {
    // isolate: disable all other owners created by earlier tests
    const owner = await makeUser("OWNER");
    await db.user.updateMany({ where: { role: "OWNER", id: { not: owner.id } }, data: { disabledAt: new Date() } });
    const other = await makeUser("OWNER");
    await changeRole(actorFor(other), owner.id, "ADMIN"); // allowed: `other` remains
    await expect(changeRole(actorFor(owner), other.id, "ADMIN")).rejects.toBeInstanceOf(UserServiceError); // owner is now admin
    await expect(setUserDisabled(actorFor(other), other.id, true)).rejects.toThrow(/own account/);
    await expect(changeRole(actorFor(other), other.id, "VIEWER")).rejects.toThrow(/own role/);
    const third = await makeUser("OWNER");
    await setUserDisabled(actorFor(third), other.id, true);
    await expect(changeRole({ ...actorFor(third), id: uid() }, third.id, "ADMIN")).rejects.toThrow(/last active owner/);
  });
});
