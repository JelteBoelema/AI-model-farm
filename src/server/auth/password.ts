import bcrypt from "bcryptjs";
import { z } from "zod";

const COST = 12;
// Pre-computed hash used to keep timing equal when an account does not exist.
const DUMMY_HASH = "$2b$12$dkAFSVy6NetYIUihxBOpeeamzyYyI0zA/MAtHiTfUCi.svDQSnDcS";

export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(256, "Password is too long");

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return hash !== null && ok;
}
