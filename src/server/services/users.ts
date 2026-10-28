import type { UserRole } from "@prisma/client";
import { z } from "zod";
import { canAssignRole } from "@/lib/rbac";
import { db } from "../db";
import { recordAudit, type Actor } from "../audit";
import { DomainError } from "../errors";
import { hashPassword, passwordSchema } from "../auth/password";

export class UserServiceError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "UserServiceError";
  }
}

const roleSchema = z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]);

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  role: roleSchema,
  password: passwordSchema,
});

export interface ActingUser {
  id: string;
  role: UserRole;
  actor: Actor;
}

export async function createUser(by: ActingUser, input: z.infer<typeof createUserSchema>) {
  const data = createUserSchema.parse(input);
  if (!canAssignRole(by.role, data.role)) throw new UserServiceError("You cannot assign this role");
  const exists = await db.user.findUnique({ where: { email: data.email }, select: { id: true } });
  if (exists) throw new UserServiceError("A user with this email already exists");
  const passwordHash = await hashPassword(data.password);
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: data.email, name: data.name, role: data.role, passwordHash },
      select: { id: true, email: true, role: true },
    });
    await recordAudit(by.actor, { action: "user.created", entityType: "user", entityId: user.id, metadata: { email: user.email, role: user.role } }, tx);
    return user;
  });
}

async function assertNotLastOwner(userId: string) {
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true, disabledAt: true } });
  if (target?.role !== "OWNER" || target.disabledAt) return;
  const owners = await db.user.count({ where: { role: "OWNER", disabledAt: null } });
  if (owners <= 1) throw new UserServiceError("The last active owner cannot be demoted or disabled");
}

export async function changeRole(by: ActingUser, userId: string, role: UserRole) {
  roleSchema.parse(role);
  if (userId === by.id) throw new UserServiceError("You cannot change your own role");
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) throw new UserServiceError("User not found");
  if (!canAssignRole(by.role, role) || !canAssignRole(by.role, target.role))
    throw new UserServiceError("You cannot assign this role");
  if (role !== "OWNER") await assertNotLastOwner(userId);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { role } });
    await recordAudit(by.actor, { action: "user.role_changed", entityType: "user", entityId: userId, metadata: { from: target.role, to: role } }, tx);
  });
}

export async function setUserDisabled(by: ActingUser, userId: string, disabled: boolean) {
  if (userId === by.id) throw new UserServiceError("You cannot disable your own account");
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) throw new UserServiceError("User not found");
  if (!canAssignRole(by.role, target.role)) throw new UserServiceError("You cannot manage this user");
  if (disabled) await assertNotLastOwner(userId);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { disabledAt: disabled ? new Date() : null } });
    await recordAudit(by.actor, { action: disabled ? "user.disabled" : "user.enabled", entityType: "user", entityId: userId }, tx);
  });
}
