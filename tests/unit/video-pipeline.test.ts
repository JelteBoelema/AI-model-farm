import { describe, expect, it } from "vitest";
import { buildCues, cueProblems, FORMAT_SPECS, STEP_OUTPUTS, stepForStatus, storyboardSchema, toSrt, toVtt, videoTechnicalChecks, type VideoFacts } from "@/lib/content-pipeline";
import { mockSpeechWav } from "@/server/providers/adapters/mock";
import { mockFromSchema } from "@/server/providers/mock-text";
import { computeCost } from "@/server/providers/pricing";

const good: VideoFacts = {
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  durationMs: 12_000,
  sizeBytes: 2_000_000,
  video: { codec: "h264", width: 1080, height: 1920, fps: 30, pixFmt: "yuv420p" },
  audio: { codec: "aac", sampleRate: 48_000, channels: 2 },
  loudness: { integratedLufs: -14.2, truePeakDb: -1.6 },
  plannedMs: 12_000,
  hasVoice: true,
  cueProblems: [],
  isMock: false,
};
const failing = (f: VideoFacts) => videoTechnicalChecks(f).filter((c) => !c.ok && c.severity === "error").map((c) => c.check);

describe("video technical checks", () => {
  it("accept a correct 9:16 H.264/AAC video", () => {
    expect(failing(good)).toEqual([]);
  });

  it("reject wrong format, codec, length, loudness and missing subtitles", () => {
    expect(failing({ ...good, video: { ...good.video!, width: 1920, height: 1080 } })).toEqual(["Resolution"]);
    expect(failing({ ...good, video: { ...good.video!, codec: "hevc" } })).toEqual(["Video codec"]);
    expect(failing({ ...good, durationMs: 13_000 })).toEqual(["Duration"]);
    expect(failing({ ...good, durationMs: 95_000, plannedMs: 95_000 })).toEqual(["Duration"]);
    expect(failing({ ...good, loudness: { integratedLufs: -23, truePeakDb: -3 } })).toEqual(["Loudness"]);
    expect(failing({ ...good, loudness: { integratedLufs: -14, truePeakDb: 0.2 } })).toEqual(["Loudness"]);
    expect(failing({ ...good, cueProblems: null })).toEqual(["Subtitles"]);
    expect(failing({ ...good, audio: null })).toEqual(["Audio track"]);
  });

  it("do not require loudness or subtitles without a voice-over, and warn about mock output", () => {
    const checks = videoTechnicalChecks({ ...good, hasVoice: false, loudness: null, cueProblems: null, isMock: true });
    expect(checks.filter((c) => !c.ok).map((c) => c.check)).toEqual(["Real provider output"]);
  });
});

describe("subtitles", () => {
  const scenes = [
    { startMs: 0, durationMs: 4000, text: "Three habits that make my mornings calm and productive, every single day of the week." },
    { startMs: 4000, durationMs: 6000, text: "" },
    { startMs: 10_000, durationMs: 4000, text: "Try one tomorrow." },
  ];

  it("splits text into short cues that stay inside their scene", () => {
    const cues = buildCues(scenes);
    expect(cues.length).toBe(3);
    expect(cueProblems(cues, 14_000)).toEqual([]);
    expect(cues.slice(0, 2).every((c) => c.endMs <= 4000)).toBe(true);
    expect(cues[2]).toMatchObject({ startMs: 10_000, endMs: 14_000, text: "Try one tomorrow." });
  });

  it("writes WebVTT and SRT", () => {
    const cues = buildCues(scenes);
    expect(toVtt(cues)).toMatch(/^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:0\d\.\d{3}\n/);
    expect(toSrt(cues)).toMatch(/^1\n00:00:00,000 --> /);
  });

  it("finds overlaps and cues past the end", () => {
    expect(cueProblems([{ startMs: 0, endMs: 2000, text: "a" }, { startMs: 1500, endMs: 3000, text: "b" }], 2500)).toEqual(["Cue 2 ends after the video", "Cue 2 overlaps the previous one"]);
  });
});

describe("storyboard", () => {
  it("asks for exactly the requested scenes with allowed clip lengths", () => {
    const schema = storyboardSchema(3, [4, 6, 8]);
    const sample = mockFromSchema(schema, "seed") as { scenes: { duration_seconds: number }[] };
    expect(sample.scenes).toHaveLength(3);
    expect(sample.scenes.every((s) => [4, 6, 8].includes(s.duration_seconds))).toBe(true);
    expect(STEP_OUTPUTS.storyboard.safeParse(sample).success).toBe(true);
  });

  it("routes video items to scenes instead of images", () => {
    expect(stepForStatus("PROMPTED", "video")).toBe("scene");
    expect(stepForStatus("PROMPTED", "photo")).toBe("image");
    expect(FORMAT_SPECS.SHORT_VIDEO?.kind).toBe("video");
    expect(FORMAT_SPECS.TALKING_HEAD).toBeUndefined();
  });
});

describe("mock speech and speech pricing", () => {
  it("produces a valid WAV whose length follows the text", () => {
    const { bytes, durationMs } = mockSpeechWav("Hello there, this is a test.");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString()).toBe("WAVE");
    expect(durationMs).toBe(28 * 70);
    expect(bytes.length).toBe(44 + Math.round((durationMs / 1000) * 24_000) * 2);
  });

  it("prices speech per 1,000 characters and video per second, rounding up", () => {
    const pricing = { currency: "EUR" as const, source: "https://example.com", updatedAt: "2026-10-01T00:00:00.000Z", free: false, models: { m: { speech_kchar: "0.30", video_second: "0.10" } } };
    expect(computeCost(pricing, "m", { speech_kchar: 1501 }).eurMicros).toBe(450_300n);
    expect(computeCost(pricing, "m", { video_second: 8 }).eurMicros).toBe(800_000n);
  });
});
