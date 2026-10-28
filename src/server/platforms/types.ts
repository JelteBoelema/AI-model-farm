// Social platform contract. Publishing only ever goes through official platform APIs; every adapter
// implements the same OAuth and publishing steps so the publishing worker is platform-agnostic.
//
// Publishing is split into steps so that a restart never publishes twice:
//   createContainers → containerStatus (until ready) → publish
// and, whenever the outcome of `publish` is unknown, findPublished is asked first.

import type { Platform } from "@prisma/client";

export type PublishFormat = "IMAGE_POST" | "CAROUSEL" | "STORY" | "SHORT_VIDEO";

export type PlatformErrorKind =
  | "auth" // token expired or revoked: reconnect
  | "insufficient_scope" // permission missing for this action
  | "rate_limited" // try later
  | "limit_reached" // platform's daily publishing limit
  | "invalid" // the post itself was refused (format, size, policy)
  | "transient" // 5xx / network
  | "timeout"; // outcome unknown: verify remotely before anything else

export class PlatformError extends Error {
  constructor(
    readonly kind: PlatformErrorKind,
    message: string,
    readonly options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "PlatformError";
  }

  get retryable() {
    return this.kind === "rate_limited" || this.kind === "transient";
  }

  /** Needs a person: reconnect, grant a permission, or publish by hand. */
  get needsHuman() {
    return this.kind === "auth" || this.kind === "insufficient_scope" || this.kind === "invalid" || this.kind === "limit_reached";
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopes: string[];
}

export interface PlatformAccount {
  externalId: string;
  handle: string;
  accountType: string;
}

export interface FormatCapability {
  ok: boolean;
  reason?: string;
}

export interface Inspection {
  account: PlatformAccount;
  scopes: string[];
  capabilities: Record<PublishFormat, FormatCapability>;
}

export interface PostMedia {
  kind: "image" | "video";
  /** Publicly fetchable URL (signed, short-lived) for platforms that pull media. */
  url: string;
  mimeType: string;
}

export interface PostRequest {
  format: PublishFormat;
  media: PostMedia[];
  caption: string;
}

export interface Published {
  externalPostId: string;
  url: string | null;
}

/** Cumulative counters of one post as the platform reports them (null: not reported). */
export interface PostMetrics {
  externalPostId: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  watchTimeSec: number | null;
  avgViewPercent: number | null;
  /** The platform's response for this post, kept as evidence. */
  raw: Record<string, unknown>;
}

export interface AccountMetrics {
  followers: number | null;
  raw: Record<string, unknown>;
}

export type ContainerState = { state: "ready" } | { state: "pending" } | { state: "failed"; reason: string };

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly isMock: boolean;
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }, signal: AbortSignal): Promise<{ tokens: TokenSet; account: PlatformAccount }>;
  refresh(tokens: TokenSet, signal: AbortSignal): Promise<TokenSet>;
  inspect(tokens: TokenSet, signal: AbortSignal): Promise<Inspection>;
  /** Uploads/registers the media; returns the id that is published later (and its parts). */
  createContainers(tokens: TokenSet, account: PlatformAccount, post: PostRequest, signal: AbortSignal): Promise<{ publishId: string; containerIds: string[] }>;
  containerStatus(tokens: TokenSet, publishId: string, signal: AbortSignal): Promise<ContainerState>;
  publish(tokens: TokenSet, account: PlatformAccount, publishId: string, signal: AbortSignal): Promise<Published>;
  /** Was this container published after all (used after a timeout or crash)? */
  findPublished(tokens: TokenSet, account: PlatformAccount, p: { publishId: string; caption: string; since: Date }, signal: AbortSignal): Promise<Published | null>;
  /** Where the numbers come from (stored with every snapshot), e.g. "instagram_graph_api:v23.0/insights". */
  readonly metricsSource: string;
  /** Statistics of published posts; posts the platform no longer knows are left out. */
  postMetrics(tokens: TokenSet, account: PlatformAccount, externalPostIds: string[], signal: AbortSignal): Promise<PostMetrics[]>;
  accountMetrics(tokens: TokenSet, account: PlatformAccount, signal: AbortSignal): Promise<AccountMetrics>;
}
