// FFmpeg wrapper for the video engine: probing, loudness measurement, mock clip rendering, scene
// normalisation, assembly to a 9:16 H.264/AAC MP4 and keyframe extraction. Every call runs in its
// own temporary directory with arguments passed as an array (no shell), and honours an AbortSignal.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RgbImage, drawText, textWidth } from "../providers/png";

export const OUTPUT = { width: 1080, height: 1920, fps: 30, audioRate: 48_000, loudnessLufs: -14, truePeakDb: -1.5 } as const;

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegError";
  }
}

function run(bin: "ffmpeg" | "ffprobe", args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split("\n").slice(-4).join(" | ");
        reject(new FfmpegError(`${bin} failed: ${tail.slice(0, 600)}`));
      } else resolve({ stdout, stderr });
    });
  });
}

const ffmpeg = (args: string[], signal?: AbortSignal) => run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], signal);

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cf-media-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface ProbeResult {
  formatName: string;
  durationMs: number;
  sizeBytes: number;
  video: { codec: string; width: number; height: number; fps: number; pixFmt: string } | null;
  audio: { codec: string; sampleRate: number; channels: number } | null;
}

function parseRate(rate: string | undefined): number {
  const [n, d] = String(rate ?? "0/1").split("/").map(Number);
  return d ? n! / d : (n ?? 0);
}

export async function probeFile(file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], signal);
  const data = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; pix_fmt?: string; sample_rate?: string; channels?: number }[];
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const a = data.streams?.find((s) => s.codec_type === "audio");
  return {
    formatName: data.format?.format_name ?? "",
    durationMs: Math.round(Number(data.format?.duration ?? 0) * 1000),
    sizeBytes: Number(data.format?.size ?? 0),
    video: v ? { codec: v.codec_name ?? "", width: v.width ?? 0, height: v.height ?? 0, fps: parseRate(v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v.r_frame_rate), pixFmt: v.pix_fmt ?? "" } : null,
    audio: a ? { codec: a.codec_name ?? "", sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 } : null,
  };
}

export async function probe(bytes: Buffer, signal?: AbortSignal): Promise<ProbeResult> {
  return withTempDir(async (dir) => {
    const file = path.join(dir, "in");
    await writeFile(file, bytes);
    return probeFile(file, signal);
  });
}

export interface Loudness {
  integratedLufs: number;
  truePeakDb: number;
}

/** EBU R128 measurement (loudnorm analysis pass). Null when the file has no audio. */
export async function measureLoudness(file: string, signal?: AbortSignal): Promise<Loudness | null> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostdin", "-i", file, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], signal).catch((err: Error) => {
    if (/does not contain any stream|Output file .* does not contain|matches no streams/i.test(err.message)) return { stderr: "" };
    throw err;
  });
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  if (!json) return null;
  const parsed = JSON.parse(json) as { input_i?: string; input_tp?: string };
  const i = Number(parsed.input_i);
  const tp = Number(parsed.input_tp);
  return Number.isFinite(i) && Number.isFinite(tp) ? { integratedLufs: i, truePeakDb: tp } : null;
}

// ─────────────────────────────── Mock rendering ───────────────────────────────

/**
 * A watermarked placeholder clip: gradient background, a "MOCK" band across the middle, the scene
 * label and a white bar sweeping across so the clip visibly moves. Never mistakable for real output.
 */
export async function renderMockClip(opts: { width: number; height: number; durationMs: number; label: string; colors: [[number, number, number], [number, number, number]] }, signal?: AbortSignal): Promise<Buffer> {
  const img = new RgbImage(opts.width, opts.height);
  const [a, b] = opts.colors;
  for (let y = 0; y < img.height; y++) {
    const t = y / img.height;
    img.fillRect(0, y, img.width, 1, [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as [number, number, number]);
  }
  const s = Math.max(2, Math.floor(img.width / 30));
  img.fillRect(0, Math.floor(img.height / 2) - 6 * s, img.width, 12 * s, [20, 20, 28]);
  drawText(img, "MOCK", Math.floor((img.width - textWidth("MOCK", s)) / 2), Math.floor(img.height / 2) - Math.floor(3.5 * s), s, [255, 255, 255]);
  const ls = Math.max(2, Math.floor(s / 2));
  drawText(img, opts.label, Math.floor((img.width - textWidth(opts.label, ls)) / 2), Math.floor(img.height / 2) + 8 * s, ls, [255, 255, 255]);
  return withTempDir(async (dir) => {
    const frame = path.join(dir, "frame.png");
    const out = path.join(dir, "clip.mp4");
    await writeFile(frame, img.toPng());
    const seconds = (opts.durationMs / 1000).toFixed(3);
    await ffmpeg(
      [
        "-loop", "1", "-framerate", "30", "-i", frame,
        "-f", "lavfi", "-i", `color=c=white:s=${Math.max(8, Math.floor(opts.width / 40))}x${opts.height}:r=30`,
        "-filter_complex", "[0:v][1:v]overlay=x='mod(t*W/2\\,W)':y=0:shortest=1,format=yuv420p[v]",
        "-map", "[v]", "-t", seconds, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-an", "-movflags", "+faststart", out,
      ],
      signal,
    );
    return readFile(out);
  });
}

// ─────────────────────────────── Assembly ───────────────────────────────

export interface AssemblyScene {
  video: Buffer;
  durationMs: number;
  /** Voice-over for this scene; trimmed to the scene so it never bleeds into the next one. */
  voice?: Buffer | null;
}

export interface AssemblyResult {
  bytes: Buffer;
  probe: ProbeResult;
  loudness: Loudness | null;
}

/**
 * Normalises every scene to 1080×1920 @ 30 fps (scale + centre crop, padded or trimmed to its planned
 * duration), concatenates them, lays the voice-over on the timeline, normalises loudness to −14 LUFS
 * and writes an H.264/AAC MP4 with fast start.
 */
export async function assembleVideo(scenes: AssemblyScene[], signal?: AbortSignal): Promise<AssemblyResult> {
  if (scenes.length === 0) throw new FfmpegError("Nothing to assemble");
  return withTempDir(async (dir) => {
    const parts: string[] = [];
    for (const [i, scene] of scenes.entries()) {
      const src = path.join(dir, `src${i}`);
      const part = path.join(dir, `part${i}.mp4`);
      await writeFile(src, scene.video);
      const sec = (scene.durationMs / 1000).toFixed(3);
      await ffmpeg(
        [
          "-i", src,
          "-vf", `scale=${OUTPUT.width}:${OUTPUT.height}:force_original_aspect_ratio=increase,crop=${OUTPUT.width}:${OUTPUT.height},fps=${OUTPUT.fps},setsar=1,tpad=stop_mode=clone:stop_duration=${sec}`,
          "-t", sec, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", part,
        ],
        signal,
      );
      parts.push(part);
    }
    const list = path.join(dir, "list.txt");
    await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
    const silent = path.join(dir, "video.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent], signal);

    const totalMs = scenes.reduce((s, x) => s + x.durationMs, 0);
    const inputs: string[] = [];
    const filters: string[] = [`anullsrc=r=${OUTPUT.audioRate}:cl=stereo,atrim=0:${(totalMs / 1000).toFixed(3)}[base]`];
    const mixIn = ["[base]"];
    let start = 0;
    for (const scene of scenes) {
      if (scene.voice?.length) {
        const n = inputs.length / 2 + 1; // input 0 is the video
        const file = path.join(dir, `voice${n}`);
        await writeFile(file, scene.voice);
        inputs.push("-i", file);
        filters.push(`[${n}:a]aresample=${OUTPUT.audioRate},aformat=channel_layouts=stereo,atrim=0:${(scene.durationMs / 1000).toFixed(3)},adelay=${start}|${start}[v${n}]`);
        mixIn.push(`[v${n}]`);
      }
      start += scene.durationMs;
    }
    filters.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:normalize=0:duration=first,loudnorm=I=${OUTPUT.loudnessLufs}:TP=${OUTPUT.truePeakDb}:LRA=11,aresample=${OUTPUT.audioRate}[a]`);
    const out = path.join(dir, "out.mp4");
    await ffmpeg(
      ["-i", silent, ...inputs, "-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", (totalMs / 1000).toFixed(3), "-movflags", "+faststart", out],
      signal,
    );
    return { bytes: await readFile(out), probe: await probeFile(out, signal), loudness: await measureLoudness(out, signal) };
  });
}

/** One PNG frame at the given time (used to show scenes to the reviewer model). */
export async function extractFrame(video: Buffer, atMs: number, signal?: AbortSignal): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const src = path.join(dir, "in");
    const out = path.join(dir, "frame.png");
    await writeFile(src, video);
    await ffmpeg(["-ss", (atMs / 1000).toFixed(3), "-i", src, "-frames:v", "1", "-vf", "scale=540:-2", out], signal);
    return readFile(out);
  });
}

/** Facts about any file for QC (probe + loudness). */
export async function inspect(bytes: Buffer, signal?: AbortSignal): Promise<{ probe: ProbeResult; loudness: Loudness | null }> {
  return withTempDir(async (dir) => {
    const file = path.join(dir, "in");
    await writeFile(file, bytes);
    return { probe: await probeFile(file, signal), loudness: await measureLoudness(file, signal) };
  });
}
