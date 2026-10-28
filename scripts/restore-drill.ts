// Restore drill: back up a database schema, restore it into a brand-new database, and prove the
// copy is complete and behaves like the original. Then simulate losing Redis and rebuild the
// queues from the restored database. Timings give the recovery time for this data volume.
//
//   pnpm drill:restore --schema load_1761... [--storage ./.data/load-storage] [--keep]
//
// In AWS the backup step is an RDS snapshot or point-in-time restore instead of pg_dump; the
// verification steps are the same (docs/runbooks/restore.md).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = (process.env.DRILL_DATABASE_URL ?? "postgresql://creatorfarm:creatorfarm@localhost:5432/creatorfarm_test").split("?")[0]!;
const STORAGE = arg("storage", "./.data/load-storage")!;
const OUT = arg("out", `.data/restore-drill-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`)!;

const sql = (url: string, query: string) => execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-Atc", query], { encoding: "utf8" }).trim();
const timed = <T>(fn: () => T): [T, number] => {
  const t = performance.now();
  const r = fn();
  return [r, Math.round(performance.now() - t) / 1000];
};
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main() {
  const schema = arg("schema") ?? sql(BASE, "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'load\\_%' ORDER BY nspname DESC LIMIT 1");
  if (!/^[a-z0-9_]+$/.test(schema)) throw new Error(`No usable source schema (got "${schema}"); run the load test with --keep first`);
  const checks: { check: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ check: name, ok, detail });
    log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 1. Backup
  mkdirSync(".data/drill", { recursive: true });
  const dump = path.join(".data/drill", `${schema}.dump`);
  const [, dumpSeconds] = timed(() => execFileSync("pg_dump", ["--format=custom", "--no-owner", `--schema=${schema}`, `--file=${dump}`, BASE]));
  log(`backup: ${(statSync(dump).size / 1024 / 1024).toFixed(1)} MB in ${dumpSeconds}s`);

  // 2. Restore into a new, empty database
  const target = `restore_drill_${Date.now()}`;
  sql(BASE, `CREATE DATABASE ${target}`);
  const targetUrl = BASE.replace(/\/[^/]+$/, `/${target}`);
  const [, restoreSeconds] = timed(() => execFileSync("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${targetUrl}`, dump]));
  log(`restore into ${target}: ${restoreSeconds}s`);

  // 3. Verify: same tables, rows, constraints, triggers and content fingerprints
  const tables = sql(BASE, `SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' ORDER BY 1`).split("\n");
  const count = (url: string, t: string) => Number(sql(url, `SELECT count(*) FROM "${schema}"."${t}"`));
  const mismatched = tables.filter((t) => count(BASE, t) !== count(targetUrl, t));
  const rows = tables.reduce((s, t) => s + count(targetUrl, t), 0);
  check("every table has the same number of rows", mismatched.length === 0, mismatched.length ? mismatched.join(", ") : `${tables.length} tables, ${rows} rows`);

  for (const [what, q] of [
    ["constraints", `SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = '${schema}'`],
    ["triggers", `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${schema}' AND NOT t.tgisinternal`],
    ["indexes", `SELECT count(*) FROM pg_indexes WHERE schemaname = '${schema}'`],
    ["applied migrations", `SELECT count(*) || ':' || max(migration_name) FROM "${schema}"._prisma_migrations WHERE finished_at IS NOT NULL`],
    ["cost ledger total", `SELECT count(*) || ':' || coalesce(sum(amount_micros), 0) FROM "${schema}".cost_ledger`],
    ["audit trail fingerprint", `SELECT md5(string_agg(id::text || action || occurred_at::text, ',' ORDER BY id)) FROM "${schema}".audit_logs`],
    ["publications fingerprint", `SELECT md5(string_agg(id::text || status || coalesce(external_post_id, ''), ',' ORDER BY id)) FROM "${schema}".publishing_jobs`],
    ["media fingerprint", `SELECT md5(string_agg(id::text || checksum_sha256, ',' ORDER BY id)) FROM "${schema}".media_assets`],
  ] as const) {
    const a = sql(BASE, q);
    const b = sql(targetUrl, q);
    check(`${what} identical`, a === b, a.length > 40 ? `${a.slice(0, 12)}…` : a);
  }

  // 4. Append-only protection survives the restore.
  let blocked = false;
  try {
    sql(targetUrl, `UPDATE "${schema}".audit_logs SET action = 'tampered' WHERE id = (SELECT id FROM "${schema}".audit_logs LIMIT 1)`);
  } catch {
    blocked = true;
  }
  check("audit log stays append-only after restore", blocked);

  // 5. The application's migration check accepts the restored database.
  const restoredAppUrl = `${targetUrl}?schema=${schema}`;
  const status = (() => {
    try {
      return execFileSync("pnpm", ["exec", "prisma", "migrate", "status"], { env: { ...process.env, DATABASE_URL: restoredAppUrl }, encoding: "utf8" });
    } catch (err) {
      return String((err as { stdout?: string }).stdout ?? err);
    }
  })();
  check("prisma migrate status: up to date", /up to date/i.test(status));

  // 6. Media objects still match their recorded checksums (sample).
  const sample = sql(targetUrl, `SELECT storage_key || ' ' || checksum_sha256 FROM "${schema}".media_assets ORDER BY random() LIMIT 25`).split("\n").filter(Boolean);
  const bad = sample.filter((line) => {
    const [key, sum] = line.split(" ");
    const file = path.join(STORAGE, key!);
    return !existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== sum;
  });
  check("media objects match their checksums", sample.length > 0 && bad.length === 0, `${sample.length - bad.length}/${sample.length} sampled`);

  // 7. Redis lost as well: rebuild the queues from the restored database.
  Object.assign(process.env, { DATABASE_URL: restoredAppUrl, REDIS_URL: "redis://localhost:6379/12", QUEUE_PREFIX: "cf-drill", LOG_LEVEL: "error", AUTH_SECRET: "drill-secret-0123456789abcdef0123456789ab", APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });
  const { redis } = await import("../src/server/redis");
  const { closeQueues, getQueue } = await import("../src/server/queue/queues");
  const { rebuildQueues } = await import("../src/workers/rebuild");
  const { db } = await import("../src/server/db");
  await redis().flushdb();
  const [rebuilt, rebuildSeconds] = await (async () => {
    const t = performance.now();
    const r = await rebuildQueues();
    return [r, Math.round(performance.now() - t) / 1000] as const;
  })();
  const schedulers = (await getQueue("maintenance").getJobSchedulers()).length;
  check("queues rebuilt from the database", schedulers > 0, `${schedulers} schedules, ${JSON.stringify(rebuilt.content)}, publishing ${JSON.stringify(rebuilt.publishing)}`);
  await redis().flushdb();
  await closeQueues();
  redis().disconnect();
  await db.$disconnect();

  const report = {
    source: schema,
    restoredInto: target,
    dumpMb: Math.round((statSync(dump).size / 1024 / 1024) * 10) / 10,
    rows,
    dumpSeconds,
    restoreSeconds,
    rebuildSeconds,
    checks,
    passed: checks.every((c) => c.ok),
    at: new Date().toISOString(),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  if (!process.argv.includes("--keep")) sql(BASE, `DROP DATABASE ${target}`);
  log(`report: ${OUT} — ${report.passed ? "PASSED" : "FAILED"}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
