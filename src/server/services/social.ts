// Social account connections. OAuth with state + PKCE (state bound to the user who started it, kept
// in Redis for 10 minutes); tokens go to the secrets manager and the row keeps only a reference.
// A new link needs the owner's explicit approval before anything can be published through it.

import { createHash, randomBytes } from "node:crypto";
import type { Platform, Prisma, SocialAccount, SocialAccountStatus } from "@prisma/client";
import { z } from "zod";
import { can, type Permission } from "@/lib/rbac";
import { recordAudit, SYSTEM_ACTOR } from "../audit";
import { db } from "../db";
import { env } from "../env";
import { DomainError } from "../errors";
import { logger } from "../logger";
import { connectAdapter, platformAdapter } from "../platforms/registry";
import { PlatformError, type Inspection, type PlatformAccount, type TokenSet } from "../platforms/types";
import { redis } from "../redis";
import { deleteSecret, requireSecret, storeSecret } from "../secrets";
import type { ActingUser } from "./users";

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `cf:oauth:${state}`;

function require(by: ActingUser, permission: Permission) {
  if (!can(by.role, permission)) throw new DomainError("You do not have permission for this action.");
}

export function callbackPath(platform: Platform) {
  return `/api/social/${platform.toLowerCase()}/callback`;
}

export function redirectUri(platform: Platform, origin: string) {
  return `${(env().AUTH_URL ?? origin).replace(/\/$/, "")}${callbackPath(platform)}`;
}

interface PendingConnect {
  userId: string;
  creatorId: string;
  platform: Platform;
  verifier: string;
  redirectUri: string;
}

export const startConnectSchema = z.object({ creatorId: z.string().uuid(), platform: z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]) });

/** Starts the OAuth flow; returns the URL to send the browser to. */
export async function startConnect(by: ActingUser, raw: z.input<typeof startConnectSchema>, origin: string) {
  require(by, "social:connect");
  const input = startConnectSchema.parse(raw);
  const creator = await db.creator.findUnique({ where: { id: input.creatorId }, select: { status: true } });
  if (!creator || creator.status === "ARCHIVED") throw new DomainError("Creator not found or archived");
  const adapter = connectAdapter(input.platform);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uri = redirectUri(input.platform, origin);
  const pending: PendingConnect = { userId: by.id, creatorId: input.creatorId, platform: input.platform, verifier, redirectUri: uri };
  await redis().set(stateKey(state), JSON.stringify(pending), "EX", STATE_TTL_SECONDS);
  await recordAudit(by.actor, { action: "social.connect_started", entityType: "creator", entityId: input.creatorId, metadata: { platform: input.platform, mock: adapter.isMock } });
  return adapter.authorizeUrl({ state, codeChallenge: challenge, redirectUri: uri });
}

async function readTokens(account: Pick<SocialAccount, "credentialRef">): Promise<TokenSet> {
  if (!account.credentialRef) throw new PlatformError("auth", "The account is not connected");
  return JSON.parse(await requireSecret(account.credentialRef)) as TokenSet;
}

export async function accountTokens(account: SocialAccount) {
  return { tokens: await readTokens(account), platformAccount: { externalId: account.externalAccountId ?? "", handle: account.handle, accountType: account.accountType ?? "" } satisfies PlatformAccount };
}

/** Status that follows from an inspection once the link is approved. */
function statusFrom(inspection: Inspection): SocialAccountStatus {
  return Object.values(inspection.capabilities).some((c) => c.ok) ? "CONNECTED" : "INSUFFICIENT_SCOPE";
}

/**
 * OAuth callback. The state must exist, be unused and belong to the signed-in user (no session
 * mix-up or CSRF). Tokens are written to the secrets manager before the row references them.
 */
export async function completeConnect(by: ActingUser, p: { platform: Platform; state: string | null; code: string | null; error: string | null }) {
  if (!p.state) throw new DomainError("Missing state");
  const raw = await redis().getdel(stateKey(p.state));
  if (!raw) throw new DomainError("This connection attempt expired or was already used; start again");
  const pending = JSON.parse(raw) as PendingConnect;
  if (pending.userId !== by.id || pending.platform !== p.platform) throw new DomainError("This connection attempt belongs to another session");
  if (p.error || !p.code) {
    await recordAudit(by.actor, { action: "social.connect_declined", entityType: "creator", entityId: pending.creatorId, metadata: { platform: p.platform, error: p.error?.slice(0, 100) } });
    throw new DomainError("The platform did not grant access");
  }
  const adapter = connectAdapter(p.platform);
  const signal = AbortSignal.timeout(30_000);
  const { tokens, account } = await adapter.exchangeCode({ code: p.code, codeVerifier: pending.verifier, redirectUri: pending.redirectUri }, signal);
  const inspection = await adapter.inspect(tokens, signal);

  const existing = await db.socialAccount.findFirst({
    where: { platform: p.platform, OR: [{ externalAccountId: account.externalId }, { handle: account.handle }] },
  });
  if (existing && existing.creatorId !== pending.creatorId) throw new DomainError(`@${account.handle} is already linked to another creator`);

  const ownerDecides = can(by.role, "social:approve");
  const row = await db.$transaction(async (tx) => {
    const data = {
      handle: account.handle,
      externalAccountId: account.externalId,
      accountType: account.accountType,
      grantedScopes: inspection.scopes,
      capabilities: inspection.capabilities as unknown as Prisma.InputJsonValue,
      tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null,
      lastVerifiedAt: new Date(),
      isMock: adapter.isMock,
      connectedById: by.id,
      connectedAt: new Date(),
      status: (ownerDecides ? statusFrom(inspection) : "PENDING_APPROVAL") as SocialAccountStatus,
    };
    const saved = existing
      ? await tx.socialAccount.update({ where: { id: existing.id }, data })
      : await tx.socialAccount.create({ data: { ...data, creatorId: pending.creatorId, platform: p.platform } });
    await tx.approval.create({
      data: {
        subjectType: "SOCIAL_ACCOUNT_LINK",
        subjectId: saved.id,
        requestedBy: "USER",
        requestedById: by.id,
        payload: { handle: account.handle, platform: p.platform, scopes: inspection.scopes, mock: adapter.isMock },
        ...(ownerDecides ? { decision: "APPROVED", decidedById: by.id, decidedAt: new Date(), reason: "Connected by the owner" } : {}),
      },
    });
    await recordAudit(by.actor, { action: "social.connected", entityType: "social_account", entityId: saved.id, metadata: { platform: p.platform, handle: account.handle, mock: adapter.isMock, pendingApproval: !ownerDecides } }, tx);
    return saved;
  });
  // Tokens are written after the row exists (the secret name uses its id) and before anything uses them.
  const ref = await storeSecret(`social/${row.id}`, JSON.stringify(tokens));
  await db.socialAccount.update({ where: { id: row.id }, data: { credentialRef: ref } });
  if (!ownerDecides)
    await db.notification.create({
      data: { severity: "WARNING", type: "social.approval_needed", title: `Approve the link to @${account.handle}`, body: `${by.actor.label} connected a ${p.platform.toLowerCase()} account; the owner must approve it before anything is published.`, link: "/social" },
    });
  return row;
}

/** Owner decision on a pending link. Rejecting removes the stored tokens. */
export async function decideConnection(by: ActingUser, accountId: string, approve: boolean, reasonRaw = "") {
  require(by, "social:approve");
  const reason = z.string().trim().max(500).parse(reasonRaw);
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new DomainError("Account not found");
  if (account.status !== "PENDING_APPROVAL") throw new DomainError("This link is not waiting for approval");
  const approval = await db.approval.findFirst({ where: { subjectType: "SOCIAL_ACCOUNT_LINK", subjectId: accountId, decision: "PENDING" }, orderBy: { createdAt: "desc" } });
  const capabilities = account.capabilities as unknown as Inspection["capabilities"];
  await db.$transaction(async (tx) => {
    if (approval) await tx.approval.update({ where: { id: approval.id }, data: { decision: approve ? "APPROVED" : "REJECTED", decidedById: by.id, decidedAt: new Date(), reason: reason || null } });
    await tx.socialAccount.update({
      where: { id: accountId },
      data: approve
        ? { status: Object.values(capabilities ?? {}).some((c) => c?.ok) ? "CONNECTED" : "INSUFFICIENT_SCOPE" }
        : { status: "NOT_CONNECTED", credentialRef: null, tokenExpiresAt: null, grantedScopes: [], capabilities: {} },
    });
    await recordAudit(by.actor, { action: approve ? "social.link_approved" : "social.link_rejected", entityType: "social_account", entityId: accountId, metadata: { reason } }, tx);
  });
  if (!approve && account.credentialRef) await deleteSecret(account.credentialRef).catch(() => undefined);
}

/** Re-reads permissions and per-format capabilities from the platform. */
export async function verifyAccount(by: ActingUser | null, accountId: string) {
  if (by) require(by, "social:connect");
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new DomainError("Account not found");
  if (!account.credentialRef) throw new DomainError("The account is not connected");
  const adapter = platformAdapter(account.platform, account.isMock);
  try {
    const inspection = await adapter.inspect(await readTokens(account), AbortSignal.timeout(30_000));
    const status = account.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : statusFrom(inspection);
    await db.socialAccount.update({ where: { id: accountId }, data: { grantedScopes: inspection.scopes, capabilities: inspection.capabilities as unknown as Prisma.InputJsonValue, lastVerifiedAt: new Date(), status } });
    await recordAudit(by?.actor ?? SYSTEM_ACTOR, { action: "social.verified", entityType: "social_account", entityId: accountId, metadata: { status, scopes: inspection.scopes } });
    return inspection;
  } catch (err) {
    if (err instanceof PlatformError && err.kind === "auth") {
      await markTokenExpired(accountId, err.message);
      throw new DomainError("The platform rejected the token; reconnect the account");
    }
    throw err;
  }
}

export async function markTokenExpired(accountId: string, why: string) {
  const account = await db.socialAccount.update({ where: { id: accountId }, data: { status: "TOKEN_EXPIRED" } });
  await db.notification.create({ data: { severity: "CRITICAL", type: "social.token_expired", title: `Reconnect @${account.handle}`, body: why.slice(0, 300), link: "/social" } });
  await recordAudit(SYSTEM_ACTOR, { action: "social.token_expired", entityType: "social_account", entityId: accountId, metadata: { why: why.slice(0, 200) } });
}

/** Refreshes tokens that expire within a week (maintenance, daily). */
export async function refreshExpiringTokens(now = new Date()) {
  const soon = new Date(now.getTime() + 7 * 86_400_000);
  const accounts = await db.socialAccount.findMany({ where: { status: { in: ["CONNECTED", "INSUFFICIENT_SCOPE"] }, credentialRef: { not: null }, tokenExpiresAt: { lt: soon } } });
  let refreshed = 0;
  for (const account of accounts) {
    try {
      const adapter = platformAdapter(account.platform, account.isMock);
      const tokens = await adapter.refresh(await readTokens(account), AbortSignal.timeout(30_000));
      await storeSecret(`social/${account.id}`, JSON.stringify(tokens));
      await db.socialAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: tokens.expiresAt ? new Date(tokens.expiresAt) : null } });
      refreshed++;
    } catch (err) {
      logger.warn({ accountId: account.id, err: (err as Error).message }, "token refresh failed");
      if (err instanceof PlatformError && err.kind === "auth") await markTokenExpired(account.id, err.message);
      else if (account.tokenExpiresAt && account.tokenExpiresAt < now) await markTokenExpired(account.id, "The token expired and could not be refreshed");
    }
  }
  return { checked: accounts.length, refreshed };
}

export const limitsSchema = z.object({ maxPostsPerDay: z.coerce.number().int().min(1).max(50), minGapMinutes: z.coerce.number().int().min(0).max(1440) });

export async function updateAccountLimits(by: ActingUser, accountId: string, raw: z.input<typeof limitsSchema>) {
  require(by, "social:connect");
  const input = limitsSchema.parse(raw);
  const policy = await db.autonomyPolicy.findFirst({ where: { scope: "GLOBAL" }, select: { maxPostsPerDay: true } });
  if (policy?.maxPostsPerDay && input.maxPostsPerDay > policy.maxPostsPerDay) throw new DomainError(`The farm-wide limit is ${policy.maxPostsPerDay} posts per day per account`);
  const before = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!before) throw new DomainError("Account not found");
  await db.socialAccount.update({ where: { id: accountId }, data: input });
  await recordAudit(by.actor, { action: "social.limits_changed", entityType: "social_account", entityId: accountId, metadata: { before: { maxPostsPerDay: before.maxPostsPerDay, minGapMinutes: before.minGapMinutes }, after: input } });
}

/** Disconnects: removes the stored tokens; scheduled posts then need a reconnect. */
export async function disconnectAccount(by: ActingUser, accountId: string) {
  require(by, "social:connect");
  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new DomainError("Account not found");
  if (account.credentialRef) await deleteSecret(account.credentialRef).catch(() => undefined);
  await db.socialAccount.update({ where: { id: accountId }, data: { status: "NOT_CONNECTED", credentialRef: null, tokenExpiresAt: null, grantedScopes: [], capabilities: {} } });
  await recordAudit(by.actor, { action: "social.disconnected", entityType: "social_account", entityId: accountId, metadata: { handle: account.handle } });
}
