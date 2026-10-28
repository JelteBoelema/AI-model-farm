// Mock social platform for mock mode and tests. Behaves like a container-based publishing API
// (create → process → publish) and stores what it "published" in mock_platform_posts, so the whole
// chain can be run and inspected without a network. Nothing here ever reaches a real platform.

import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../db";
import { PlatformError, type ContainerState, type Inspection, type PlatformAccount, type PlatformAdapter, type PostRequest, type Published, type PublishFormat, type TokenSet } from "./types";

export const MOCK_SCOPES = ["profile", "content_publish", "insights"] as const;
const FORMATS: PublishFormat[] = ["IMAGE_POST", "CAROUSEL", "STORY", "SHORT_VIDEO"];

/** Test hooks; the defaults behave like a healthy platform. */
export const mockPlatformBehaviour = {
  /** Status checks a container stays "pending" before it is ready. */
  processingPolls: 0,
  /** Publish succeeds on the platform, but the response is lost (a timeout). */
  loseNextPublishResponse: false,
  /** Next publish fails with this error kind. */
  failNextPublish: null as PlatformError["kind"] | null,
  reset() {
    this.processingPolls = 0;
    this.loseNextPublishResponse = false;
    this.failNextPublish = null;
  },
};

const pending = new Map<string, { polls: number; mediaKinds: string[]; caption: string }>();

/** Consent codes carry the handle the user typed on the mock consent page. */
export function mockConsentCode(handle: string): string {
  return `mock.${Buffer.from(handle).toString("base64url")}.${randomBytes(6).toString("hex")}`;
}

function handleFromCode(code: string): string {
  const [prefix, encoded] = code.split(".");
  if (prefix !== "mock" || !encoded) throw new PlatformError("invalid", "Invalid authorization code");
  const handle = Buffer.from(encoded, "base64url").toString();
  if (!/^[a-z0-9._]{2,30}$/.test(handle)) throw new PlatformError("invalid", "Invalid handle");
  return handle;
}

/** Handles ending in "_limited" connect without the publishing permission (to exercise that path). */
const scopesFor = (handle: string) => (handle.endsWith("_limited") ? MOCK_SCOPES.filter((s) => s !== "content_publish") : [...MOCK_SCOPES]);

export class MockPlatformAdapter implements PlatformAdapter {
  readonly platform = "INSTAGRAM" as const;
  readonly isMock = true;

  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const q = new URLSearchParams({ state: p.state, redirect_uri: p.redirectUri, code_challenge: p.codeChallenge });
    return `/social/mock-authorize?${q}`;
  }

  async exchangeCode(p: { code: string }): Promise<{ tokens: TokenSet; account: PlatformAccount }> {
    const handle = handleFromCode(p.code);
    return {
      tokens: { accessToken: `mock-token-${randomUUID()}`, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(), scopes: scopesFor(handle) },
      account: { externalId: `mock-${handle}`, handle, accountType: "mock_creator" },
    };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    return { ...tokens, accessToken: `mock-token-${randomUUID()}`, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString() };
  }

  async inspect(tokens: TokenSet): Promise<Inspection> {
    if (!tokens.accessToken.startsWith("mock-token-")) throw new PlatformError("auth", "Token rejected");
    const canPublish = tokens.scopes.includes("content_publish");
    const capabilities = Object.fromEntries(FORMATS.map((f) => [f, canPublish ? { ok: true } : { ok: false, reason: "Missing permission: content_publish" }])) as Inspection["capabilities"];
    return { account: { externalId: "", handle: "", accountType: "mock_creator" }, scopes: tokens.scopes, capabilities };
  }

  async createContainers(tokens: TokenSet, _account: PlatformAccount, post: PostRequest): Promise<{ publishId: string; containerIds: string[] }> {
    if (!tokens.scopes.includes("content_publish")) throw new PlatformError("insufficient_scope", "Missing permission: content_publish");
    if (post.media.length === 0) throw new PlatformError("invalid", "No media to publish");
    if (post.caption.length > 2200) throw new PlatformError("invalid", "Caption longer than 2,200 characters");
    const containerIds = post.media.map(() => `mockc_${randomUUID()}`);
    const publishId = post.media.length > 1 ? `mockc_${randomUUID()}` : containerIds[0]!;
    pending.set(publishId, { polls: mockPlatformBehaviour.processingPolls, mediaKinds: post.media.map((m) => m.kind), caption: post.caption });
    return { publishId, containerIds };
  }

  async containerStatus(_tokens: TokenSet, publishId: string): Promise<ContainerState> {
    const c = pending.get(publishId);
    if (!c) return { state: "ready" }; // e.g. after a worker restart: the mock processed it meanwhile
    if (c.polls > 0) {
      c.polls--;
      return { state: "pending" };
    }
    return { state: "ready" };
  }

  async publish(_tokens: TokenSet, account: PlatformAccount, publishId: string): Promise<Published> {
    if (mockPlatformBehaviour.failNextPublish) {
      const kind = mockPlatformBehaviour.failNextPublish;
      mockPlatformBehaviour.failNextPublish = null;
      throw new PlatformError(kind, `Mock platform refused the publication (${kind})`, kind === "rate_limited" ? { retryAfterMs: 1000 } : {});
    }
    const existing = await this.lookup(account, publishId);
    if (existing) throw new PlatformError("invalid", "This container was already published"); // like a real platform
    const c = pending.get(publishId);
    const row = await db.mockPlatformPost.create({
      data: {
        socialAccountId: await accountId(account),
        externalPostId: `mockpost_${randomUUID()}`,
        containerIds: [publishId],
        caption: c?.caption ?? "",
        mediaKinds: c?.mediaKinds ?? [],
      },
    });
    pending.delete(publishId);
    const published = { externalPostId: row.externalPostId, url: `/social/mock-feed/${row.socialAccountId}#${row.externalPostId}` };
    if (mockPlatformBehaviour.loseNextPublishResponse) {
      mockPlatformBehaviour.loseNextPublishResponse = false;
      throw new PlatformError("timeout", "No response from the platform; the outcome is unknown");
    }
    return published;
  }

  async findPublished(_tokens: TokenSet, account: PlatformAccount, p: { publishId: string }): Promise<Published | null> {
    return this.lookup(account, p.publishId);
  }

  private async lookup(account: PlatformAccount, publishId: string): Promise<Published | null> {
    const row = await db.mockPlatformPost.findFirst({ where: { containerIds: { has: publishId }, socialAccount: { externalAccountId: account.externalId } } });
    return row ? { externalPostId: row.externalPostId, url: `/social/mock-feed/${row.socialAccountId}#${row.externalPostId}` } : null;
  }
}

async function accountId(account: PlatformAccount): Promise<string> {
  const row = await db.socialAccount.findFirst({ where: { externalAccountId: account.externalId, isMock: true }, select: { id: true } });
  if (!row) throw new PlatformError("auth", "Unknown mock account");
  return row.id;
}
