// Identifies uploaded images by their magic bytes (never by file name or browser-supplied MIME type)
// and reads their pixel dimensions from the header.

export interface ImageMeta {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

function png(buf: Buffer): ImageMeta | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { mimeType: "image/png", extension: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf: Buffer): ImageMeta | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mimeType: "image/jpeg", extension: "jpg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function webp(buf: Buffer): ImageMeta | null {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  const base = { mimeType: "image/webp" as const, extension: "webp" as const };
  if (chunk === "VP8X") return { ...base, width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { ...base, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return { ...base, width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

export function sniffImage(buf: Buffer): ImageMeta | null {
  const meta = png(buf) ?? jpeg(buf) ?? webp(buf);
  if (!meta || meta.width <= 0 || meta.height <= 0) return null;
  return meta;
}
