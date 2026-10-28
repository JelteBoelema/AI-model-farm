// Explicit status transition tables. The database stores statuses; this module is the single
// place that decides which transitions are legal. Every service that changes a status calls
// assertTransition() before writing.

import type {
  CampaignStatus,
  CharacterProfileStatus,
  ContentStatus,
  CreatorStatus,
  GenerationJobStatus,
  MediaStatus,
  PublishingStatus,
} from "@prisma/client";

type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const creatorTransitions: TransitionTable<CreatorStatus> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};

export const campaignTransitions: TransitionTable<CampaignStatus> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["PAUSED", "COMPLETED"],
  PAUSED: ["ACTIVE", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export const characterProfileTransitions: TransitionTable<CharacterProfileStatus> = {
  DRAFT: ["APPROVED"],
  APPROVED: ["SUPERSEDED"],
  SUPERSEDED: [],
};

// Content moves forward through the factory pipeline. FAILED can be resumed at the step that failed,
// which is why it may return to any working state; a failed publication never forces regeneration.
export const contentTransitions: TransitionTable<ContentStatus> = {
  IDEA: ["BRIEFED", "REJECTED", "ARCHIVED"],
  BRIEFED: ["SCRIPTED", "PROMPTED", "REJECTED", "ARCHIVED"],
  SCRIPTED: ["PROMPTED", "BRIEFED", "REJECTED", "ARCHIVED"],
  PROMPTED: ["GENERATING", "SCRIPTED", "ARCHIVED"],
  GENERATING: ["QC_REVIEW", "FAILED"],
  QC_REVIEW: ["READY", "PROMPTED", "REJECTED", "FAILED"],
  READY: ["APPROVED", "PROMPTED", "REJECTED"],
  APPROVED: ["SCHEDULED", "READY", "ARCHIVED"],
  // The publication states follow the item's publishing jobs (see publishing.syncItemStatus).
  SCHEDULED: ["PUBLISHING", "APPROVED", "PUBLISHED", "FAILED"],
  PUBLISHING: ["PUBLISHED", "SCHEDULED", "FAILED", "APPROVED"],
  PUBLISHED: ["ARCHIVED"],
  FAILED: ["PROMPTED", "GENERATING", "QC_REVIEW", "APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED", "ARCHIVED"],
  REJECTED: ["IDEA", "ARCHIVED"],
  ARCHIVED: [],
};

export const generationJobTransitions: TransitionTable<GenerationJobStatus> = {
  QUEUED: ["RUNNING", "CANCELLED", "BLOCKED_BUDGET", "BLOCKED_POLICY"],
  // Budget and policy checks run inside the attempt, so a running job can end blocked.
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED_BUDGET", "BLOCKED_POLICY"],
  FAILED: ["QUEUED", "DEAD_LETTER"],
  BLOCKED_BUDGET: ["QUEUED", "CANCELLED"],
  BLOCKED_POLICY: ["QUEUED", "CANCELLED"],
  SUCCEEDED: [],
  CANCELLED: [],
  DEAD_LETTER: ["QUEUED"],
};

export const mediaTransitions: TransitionTable<MediaStatus> = {
  PENDING_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["REJECTED", "ARCHIVED"],
  REJECTED: ["APPROVED", "ARCHIVED"],
  ARCHIVED: [],
};

// PUBLISHING → AWAITING_CONFIRMATION covers timeouts: the platform is queried for the outcome
// before any new publish request is sent.
export const publishingTransitions: TransitionTable<PublishingStatus> = {
  SCHEDULED: ["QUEUED", "CANCELLED", "NEEDS_MANUAL_ACTION"],
  QUEUED: ["PUBLISHING", "SCHEDULED", "CANCELLED", "NEEDS_MANUAL_ACTION"],
  PUBLISHING: ["PUBLISHED", "AWAITING_CONFIRMATION", "FAILED"],
  AWAITING_CONFIRMATION: ["PUBLISHED", "FAILED", "NEEDS_MANUAL_ACTION"],
  FAILED: ["QUEUED", "CANCELLED", "NEEDS_MANUAL_ACTION"],
  NEEDS_MANUAL_ACTION: ["QUEUED", "PUBLISHED", "CANCELLED"],
  PUBLISHED: [],
  CANCELLED: [],
};

export const machines = {
  creator: creatorTransitions,
  campaign: campaignTransitions,
  characterProfile: characterProfileTransitions,
  content: contentTransitions,
  generationJob: generationJobTransitions,
  media: mediaTransitions,
  publishing: publishingTransitions,
} as const;

export type MachineName = keyof typeof machines;
type StateOf<M extends MachineName> = keyof (typeof machines)[M] & string;

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: MachineName,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${machine} status transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition<M extends MachineName>(machine: M, from: StateOf<M>, to: StateOf<M>): boolean {
  const table = machines[machine] as TransitionTable<string>;
  return table[from]?.includes(to) ?? false;
}

export function assertTransition<M extends MachineName>(machine: M, from: StateOf<M>, to: StateOf<M>): void {
  if (!canTransition(machine, from, to)) throw new InvalidTransitionError(machine, from, to);
}

export function isTerminal<M extends MachineName>(machine: M, state: StateOf<M>): boolean {
  const table = machines[machine] as TransitionTable<string>;
  return (table[state]?.length ?? 0) === 0;
}
