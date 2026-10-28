import { describe, expect, it } from "vitest";
import { ensureDisclosure, PHOTO_FORMATS, STEP_JSON_SCHEMAS, STEP_OUTPUTS, stepForStatus, technicalChecks, technicalPass } from "@/lib/content-pipeline";
import { canTransition } from "@/lib/state-machines";
import { mockFromSchema } from "@/server/providers/mock-text";

const facts = { mimeType: "image/png", width: 1024, height: 1536, sizeBytes: 2_000_000, isMock: false };

describe("technical checks", () => {
  it("pass a correct real image", () => {
    const checks = technicalChecks(facts, { size: "1024x1536" });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(technicalPass(checks)).toBe(true);
  });

  it("fail on wrong aspect ratio, tiny images and unsupported types", () => {
    expect(technicalPass(technicalChecks({ ...facts, width: 1536, height: 1024 }, { size: "1024x1536" }))).toBe(false);
    expect(technicalPass(technicalChecks({ ...facts, width: 300, height: 450 }, { size: "1024x1536" }))).toBe(false);
    expect(technicalPass(technicalChecks({ ...facts, mimeType: "image/gif" }, { size: "1024x1536" }))).toBe(false);
  });

  it("only warn about mock output, duplicates and sub-1024 resolution", () => {
    const checks = technicalChecks({ ...facts, width: 512, height: 768, isMock: true, duplicateOf: "abc" }, { size: "1024x1536" });
    expect(technicalPass(checks)).toBe(true);
    expect(checks.filter((c) => !c.ok).map((c) => c.check)).toEqual(["Publishing resolution", "Unique image", "Real provider output"]);
  });
});

describe("pipeline definition", () => {
  it("maps statuses to the next step", () => {
    expect(["IDEA", "BRIEFED", "SCRIPTED", "PROMPTED", "QC_REVIEW"].map((s) => stepForStatus(s as never))).toEqual(["brief", "script", "caption", "image", null]);
  });

  it("only offers transitions the content state machine allows", () => {
    for (const [from, to] of [["IDEA", "BRIEFED"], ["BRIEFED", "SCRIPTED"], ["SCRIPTED", "PROMPTED"], ["PROMPTED", "GENERATING"], ["GENERATING", "QC_REVIEW"], ["QC_REVIEW", "READY"], ["READY", "APPROVED"], ["GENERATING", "FAILED"], ["FAILED", "GENERATING"], ["FAILED", "QC_REVIEW"]] as const)
      expect(canTransition("content", from, to)).toBe(true);
  });

  it("has output schemas that the validators accept (shape check via the mock generator)", () => {
    for (const step of ["brief", "script", "caption", "qc"] as const) {
      const sample = mockFromSchema(STEP_JSON_SCHEMAS[step] as never, "seed");
      expect(STEP_OUTPUTS[step].safeParse(sample).success).toBe(true);
    }
  });

  it("defines photo formats with sane shot counts", () => {
    for (const spec of Object.values(PHOTO_FORMATS)) expect(spec!.minShots <= spec!.defaultShots && spec!.defaultShots <= spec!.maxShots).toBe(true);
  });

  it("adds the AI disclosure only when missing", () => {
    expect(ensureDisclosure("Hello", "Made with AI")).toBe("Hello\n\nMade with AI");
    expect(ensureDisclosure("Hello — made with ai", "Made with AI")).toBe("Hello — made with ai");
  });
});
