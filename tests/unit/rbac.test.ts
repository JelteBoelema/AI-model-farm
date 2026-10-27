import { describe, expect, it } from "vitest";
import { can, canAssignRole, hasRole } from "@/lib/rbac";

describe("rbac", () => {
  it("orders roles", () => {
    expect(hasRole("OWNER", "ADMIN")).toBe(true);
    expect(hasRole("VIEWER", "OPERATOR")).toBe(false);
  });

  it("lets operators pause but not resume", () => {
    expect(can("OPERATOR", "controls:pause")).toBe(true);
    expect(can("OPERATOR", "controls:resume")).toBe(false);
    expect(can("ADMIN", "controls:resume")).toBe(true);
  });

  it("reserves budget increases and user management for the owner", () => {
    expect(can("ADMIN", "budgets:raise")).toBe(false);
    expect(can("ADMIN", "budgets:lower")).toBe(true);
    expect(can("OWNER", "budgets:raise")).toBe(true);
    expect(can("ADMIN", "users:manage")).toBe(false);
  });

  it("viewers are read-only", () => {
    expect(can("VIEWER", "dashboard:view")).toBe(true);
    expect(can("VIEWER", "content:edit")).toBe(false);
    expect(can("VIEWER", "controls:pause")).toBe(false);
  });

  it("prevents role escalation", () => {
    expect(canAssignRole("OWNER", "OWNER")).toBe(true);
    expect(canAssignRole("ADMIN", "OPERATOR")).toBe(false); // admins cannot manage users at all
    expect(canAssignRole("OPERATOR", "VIEWER")).toBe(false);
  });
});
