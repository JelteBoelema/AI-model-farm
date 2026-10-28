import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDays, dayKey, weekdayOf, zonedParts, zonedToUtc } from "@/lib/time";
import { crc32, zip } from "@/server/media/zip";

describe("time zones", () => {
  it("converts wall-clock times in a zone to UTC, including across DST", () => {
    expect(zonedToUtc(2026, 7, 1, 18, 0, "Europe/Amsterdam").toISOString()).toBe("2026-07-01T16:00:00.000Z"); // CEST
    expect(zonedToUtc(2026, 12, 1, 18, 0, "Europe/Amsterdam").toISOString()).toBe("2026-12-01T17:00:00.000Z"); // CET
    expect(zonedToUtc(2026, 7, 1, 9, 30, "America/New_York").toISOString()).toBe("2026-07-01T13:30:00.000Z");
    // 02:30 does not exist on 29 March 2026 in Amsterdam: moves forward
    expect(zonedToUtc(2026, 3, 29, 2, 30, "Europe/Amsterdam").toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // 02:30 happens twice on 25 October 2026: the first (summer-time) occurrence
    expect(zonedToUtc(2026, 10, 25, 2, 30, "Europe/Amsterdam").toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("finds the local day and weekday", () => {
    const late = new Date("2026-10-28T23:30:00Z");
    expect(dayKey(late, "UTC")).toBe("2026-10-28");
    expect(dayKey(late, "Europe/Amsterdam")).toBe("2026-10-29");
    expect(zonedParts(late, "Europe/Amsterdam")).toMatchObject({ hour: 0, minute: 30, weekday: 4 });
    expect(weekdayOf("2026-10-28")).toBe(3);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("zip", () => {
  it("computes CRC-32 and writes an archive that unzip accepts", () => {
    expect(crc32(Buffer.from("123456789")).toString(16)).toBe("cbf43926");
    const dir = mkdtempSync(path.join(os.tmpdir(), "zip-"));
    const file = path.join(dir, "a.zip");
    writeFileSync(file, zip([{ name: "caption.txt", data: Buffer.from("Hello") }, { name: "media/01.png", data: Buffer.from([1, 2, 3]) }]));
    const listing = execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(','.join(z.namelist())); print(z.read('caption.txt').decode())", file]).toString();
    expect(listing.trim().split("\n")).toEqual(["None", "caption.txt,media/01.png", "Hello"]);
    expect(readFileSync(file).subarray(0, 2).toString()).toBe("PK");
  });

  it("refuses path traversal", () => {
    expect(() => zip([{ name: "../evil", data: Buffer.alloc(0) }])).toThrow();
  });
});
