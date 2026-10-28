import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sniffImage } from "@/lib/image-meta";

const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures", name));

describe("image sniffing", () => {
  it.each([
    ["ref-600.png", "image/png", 600, 600],
    ["ref-640x512.jpg", "image/jpeg", 640, 512],
    ["ref-512x520.webp", "image/webp", 512, 520],
    ["ref-530x514-lossless.webp", "image/webp", 530, 514],
    ["ref-540x520-alpha.webp", "image/webp", 540, 520],
  ])("reads %s", (file, mime, w, h) => {
    expect(sniffImage(fixture(file))).toMatchObject({ mimeType: mime, width: w, height: h });
  });

  it("rejects non-images and spoofed content regardless of extension", () => {
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a\x01\x00\x01\x00"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(fixture("ref-600.png").subarray(0, 20))).toBeNull(); // truncated header
  });
});
