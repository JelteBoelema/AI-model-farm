// Append-only audit trail. Every state-changing service call records who did what to which entity.
// Writes go through the caller's transaction where one exists, so the audit entry and the change
// commit or roll back together.

import type { ActorType, Prisma } from "@prisma/client";
import { db, type DbOrTx } from "./db";

export interface Actor {
  type: ActorType;
  id?: string | null;
  label: string;
}

export const SYSTEM_ACTOR: Actor = { type: "SYSTEM", id: null, label: "system" };

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential(?!Ref)/i;

/** Remove anything that looks like a credential before it reaches the audit table. */
export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrubMetadata(v, depth + 1));
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[REDACTED]" : scrubMetadata(v, depth + 1)]),
    );
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export async function recordAudit(actor: Actor, entry: AuditEntry, client: DbOrTx = db): Promise<void> {
  await client.auditLog.create({
    data: {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: scrubMetadata(entry.metadata ?? {}) as Prisma.InputJsonValue,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent?.slice(0, 512) ?? null,
    },
  });
}
