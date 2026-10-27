// Credentials are never stored in our tables. Rows carry a *reference* such as
// "env:ANTHROPIC_API_KEY" or "aws-sm:creatorfarm/prod/anthropic" which is resolved at call time.

import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { env } from "./env";

export class SecretNotConfiguredError extends Error {
  constructor(readonly ref: string) {
    super(`Secret not configured: ${ref}`);
    this.name = "SecretNotConfiguredError";
  }
}

export interface SecretStore {
  readonly scheme: string;
  get(name: string): Promise<string | null>;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/;

export const envSecretStore: SecretStore = {
  scheme: "env",
  async get(name) {
    if (!ENV_NAME.test(name)) throw new Error("Invalid env secret name");
    const value = process.env[name];
    return value && value.trim() !== "" ? value : null;
  },
};

let smClient: SecretsManagerClient | undefined;
const SECRET_CACHE_MS = 5 * 60 * 1000;
const secretCache = new Map<string, { value: string | null; expires: number }>();

// AWS Secrets Manager (region and credentials from the standard AWS provider chain / task role).
const awsSecretStore: SecretStore = {
  scheme: "aws-sm",
  async get(name) {
    const hit = secretCache.get(name);
    if (hit && hit.expires > Date.now()) return hit.value;
    smClient ??= new SecretsManagerClient({});
    let value: string | null;
    try {
      const out = await smClient.send(new GetSecretValueCommand({ SecretId: name }));
      value = out.SecretString ?? null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) value = null;
      else throw err;
    }
    secretCache.set(name, { value, expires: Date.now() + SECRET_CACHE_MS });
    return value;
  },
};

const stores: Record<string, SecretStore> = { env: envSecretStore, "aws-sm": awsSecretStore };

export function parseSecretRef(ref: string): { scheme: string; name: string } {
  const idx = ref.indexOf(":");
  if (idx <= 0) throw new Error(`Malformed secret reference: ${ref}`);
  return { scheme: ref.slice(0, idx), name: ref.slice(idx + 1) };
}

export async function resolveSecret(ref: string): Promise<string | null> {
  const { scheme, name } = parseSecretRef(ref);
  const store = stores[scheme];
  if (!store) throw new Error(`Unknown secret store: ${scheme}`);
  if (scheme === "aws-sm" && env().SECRETS_DRIVER !== "aws") return null;
  return store.get(name);
}

export async function requireSecret(ref: string): Promise<string> {
  const value = await resolveSecret(ref);
  if (value === null) throw new SecretNotConfiguredError(ref);
  return value;
}

export async function isSecretConfigured(ref: string | null | undefined): Promise<boolean> {
  if (!ref) return false;
  try {
    return (await resolveSecret(ref)) !== null;
  } catch {
    return false;
  }
}
