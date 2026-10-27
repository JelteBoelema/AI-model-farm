import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, InvalidTransitionError, isTerminal, machines } from "@/lib/state-machines";

describe("state machines", () => {
  it("allows the forward content pipeline", () => {
    const path = ["IDEA", "BRIEFED", "SCRIPTED", "PROMPTED", "GENERATING", "QC_REVIEW", "READY", "APPROVED", "SCHEDULED", "PUBLISHING", "PUBLISHED"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition("content", path[i]!, path[i + 1]!)).toBe(true);
  });

  it("rejects skipping generation and QC", () => {
    expect(canTransition("content", "IDEA", "PUBLISHED")).toBe(false);
    expect(() => assertTransition("content", "PROMPTED", "APPROVED")).toThrow(InvalidTransitionError);
  });

  it("lets a failed publication be rescheduled without regenerating", () => {
    expect(canTransition("content", "FAILED", "SCHEDULED")).toBe(true);
    expect(canTransition("publishing", "FAILED", "QUEUED")).toBe(true);
  });

  it("forces publication timeouts through remote confirmation", () => {
    expect(canTransition("publishing", "PUBLISHING", "AWAITING_CONFIRMATION")).toBe(true);
    expect(canTransition("publishing", "AWAITING_CONFIRMATION", "PUBLISHING")).toBe(false);
    expect(canTransition("publishing", "AWAITING_CONFIRMATION", "QUEUED")).toBe(false);
  });

  it("treats published, cancelled and archived as terminal", () => {
    expect(isTerminal("publishing", "PUBLISHED")).toBe(true);
    expect(isTerminal("publishing", "CANCELLED")).toBe(true);
    expect(isTerminal("creator", "ARCHIVED")).toBe(true);
    expect(isTerminal("generationJob", "SUCCEEDED")).toBe(true);
  });

  it("only references known states in every table", () => {
    for (const [name, table] of Object.entries(machines)) {
      const states = new Set(Object.keys(table));
      for (const targets of Object.values(table) as string[][]) for (const t of targets) expect(states.has(t), `${name}: ${t}`).toBe(true);
    }
  });
});
