import { describe, expect, it } from "vitest";
import { assertHuman, attemptsFor, mergePolicies } from "@/server/services/policy";
import { loosenedFields } from "@/server/services/policy-admin";

const row = (scope: "GLOBAL" | "CREATOR" | "CAMPAIGN", v: Partial<Parameters<typeof mergePolicies>[0][number]> = {}) => ({
  scope,
  maxCostPerJobMicros: null,
  maxGenerationsPerItem: null,
  maxConcurrentJobs: null,
  maxPostsPerDay: null,
  maxWorkflowMinutes: null,
  maxRetries: null,
  maxNewItemsPerDay: null,
  autoApproveMinScore: null,
  requireHumanApproval: false,
  ...v,
});

const values = (v: Partial<Parameters<typeof loosenedFields>[1]> = {}) => ({
  maxCostPerJobMicros: 5_000_000n,
  maxGenerationsPerItem: 6,
  maxConcurrentJobs: 10,
  maxPostsPerDay: 3,
  maxWorkflowMinutes: 180,
  maxRetries: 3,
  maxNewItemsPerDay: 1,
  autoApproveMinScore: null,
  requireHumanApproval: false,
  ...v,
});

describe("effective policy", () => {
  it("takes the strictest limit of all scopes and names its source", () => {
    const eff = mergePolicies([
      row("CAMPAIGN", { maxPostsPerDay: 2 }),
      row("GLOBAL", { maxPostsPerDay: 3, maxCostPerJobMicros: 5_000_000n, maxRetries: 3 }),
      row("CREATOR", { maxCostPerJobMicros: 1_000_000n, maxRetries: 5 }),
    ]);
    expect(eff).toMatchObject({ maxPostsPerDay: 2, maxCostPerJobMicros: 1_000_000n, maxRetries: 3 });
    expect(eff.source).toMatchObject({ maxPostsPerDay: "CAMPAIGN", maxCostPerJobMicros: "CREATOR", maxRetries: "GLOBAL" });
  });

  it("lets a scope only tighten: an unset scoped limit keeps the global one", () => {
    expect(mergePolicies([row("GLOBAL", { maxConcurrentJobs: 4 }), row("CREATOR")]).maxConcurrentJobs).toBe(4);
  });

  it("allows self-approval only when the global policy does; scopes can only raise the bar", () => {
    expect(mergePolicies([row("CREATOR", { autoApproveMinScore: 10 })]).autoApproveMinScore).toBeNull();
    expect(mergePolicies([row("GLOBAL", { autoApproveMinScore: 80 }), row("CREATOR", { autoApproveMinScore: 60 })]).autoApproveMinScore).toBe(80);
    expect(mergePolicies([row("GLOBAL", { autoApproveMinScore: 80 }), row("CAMPAIGN", { autoApproveMinScore: 90 })])).toMatchObject({ autoApproveMinScore: 90, source: { autoApproveMinScore: "CAMPAIGN" } });
    expect(mergePolicies([row("GLOBAL"), row("CREATOR", { requireHumanApproval: true })]).requireHumanApproval).toBe(true);
  });

  it("caps queue attempts by the retry limit", () => {
    expect(attemptsFor(5, { maxRetries: null })).toBe(5);
    expect(attemptsFor(5, { maxRetries: 2 })).toBe(3);
    expect(attemptsFor(2, { maxRetries: 9 })).toBe(2);
    expect(attemptsFor(5, { maxRetries: 0 })).toBe(1);
  });

  it("refuses limit changes by anything but a person", () => {
    expect(() => assertHuman({ type: "AGENT", label: "autopilot" })).toThrow(/person/);
    expect(() => assertHuman({ type: "SYSTEM", label: "system" })).toThrow(/person/);
    expect(() => assertHuman({ type: "USER", label: "owner" })).not.toThrow();
  });
});

describe("which changes loosen a limit (and need the owner)", () => {
  it("treats raising or removing a cap as loosening, lowering as tightening", () => {
    expect(loosenedFields(values(), values({ maxPostsPerDay: 2, maxRetries: 1 }))).toEqual([]);
    expect(loosenedFields(values(), values({ maxPostsPerDay: 5, maxCostPerJobMicros: null }))).toEqual(["maxCostPerJobMicros", "maxPostsPerDay"]);
    // A first policy with caps is tightening.
    expect(loosenedFields(null, values())).toEqual([]);
  });

  it("treats switching on or lowering farm-wide self-approval, and dropping required review, as loosening", () => {
    expect(loosenedFields(values(), values({ autoApproveMinScore: 90 }))).toEqual(["autoApproveMinScore"]);
    expect(loosenedFields(values({ autoApproveMinScore: 90 }), values({ autoApproveMinScore: 95 }))).toEqual([]);
    expect(loosenedFields(values({ autoApproveMinScore: 90 }), values({ autoApproveMinScore: null }))).toEqual([]);
    expect(loosenedFields(values({ requireHumanApproval: true }), values())).toEqual(["requireHumanApproval"]);
  });

  it("for a scoped bar, only lowering or removing it loosens", () => {
    expect(loosenedFields(null, values({ autoApproveMinScore: 90 }), "CREATOR")).toEqual([]);
    expect(loosenedFields(values({ autoApproveMinScore: 90 }), values({ autoApproveMinScore: null }), "CREATOR")).toEqual(["autoApproveMinScore"]);
  });
});
