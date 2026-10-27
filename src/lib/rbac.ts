// Role-based access control. Roles are ordered; permissions are explicit so that a route or
// server action can ask for exactly what it needs.

import type { UserRole } from "@prisma/client";

export const ROLE_ORDER: readonly UserRole[] = ["VIEWER", "OPERATOR", "ADMIN", "OWNER"];

export const PERMISSIONS = {
  "dashboard:view": "VIEWER",
  "audit:view": "VIEWER",
  "creators:edit": "OPERATOR",
  "prompts:edit": "OPERATOR",
  "content:edit": "OPERATOR",
  "content:approve": "OPERATOR",
  "generation:run": "OPERATOR",
  "publishing:schedule": "OPERATOR",
  "controls:pause": "OPERATOR", // anyone operating the farm may pull the brake
  "controls:resume": "ADMIN",
  "providers:manage": "ADMIN",
  "social:connect": "ADMIN",
  "budgets:lower": "ADMIN",
  "budgets:raise": "OWNER", // raising hard limits needs the owner's explicit decision
  "policies:manage": "OWNER",
  "users:manage": "OWNER",
} as const satisfies Record<string, UserRole>;

export type Permission = keyof typeof PERMISSIONS;

export function roleRank(role: UserRole): number {
  return ROLE_ORDER.indexOf(role);
}

export function hasRole(role: UserRole, minimum: UserRole): boolean {
  return roleRank(role) >= roleRank(minimum);
}

export function can(role: UserRole, permission: Permission): boolean {
  return hasRole(role, PERMISSIONS[permission]);
}

/** A user may only assign roles strictly below their own, except the owner who may assign any role. */
export function canAssignRole(actor: UserRole, target: UserRole): boolean {
  if (actor === "OWNER") return true;
  return can(actor, "users:manage") && roleRank(target) < roleRank(actor);
}
