// Credentials are never stored in our tables. Rows carry a *reference* such as
// "env:ANTHROPIC_API_KEY" or "aws-sm:creatorfarm/prod/anthropic" which is resolved at call time.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { decrypt, encrypt } from "./crypto";
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

// Secrets the platform writes itself (social-account tokens). Development and tests keep them in
// AES-256-GCM encrypted files (the secret name is bound as associated data); production writes to
// AWS Secrets Manager, which env validation enforces.
const LOCAL_NAME = /^[a-z0-9][a-z0-9/_-]{2,200}$/;
const localDir = () => process.env.SECRETS_LOCAL_DIR ?? "./.data/secrets";
const localFile = (name: string) => {
  if (!LOCAL_NAME.test(name) || name.includes("..")) throw new Error("Invalid secret name");
  return path.join(localDir(), `${name.replaceAll("/", "__")}.enc`);
};

const localSecretStore: SecretStore = {
  scheme: "local",
  async get(name) {
    try {
      return decrypt((await readFile(localFile(name), "utf8")).trim(), env().APP_ENCRYPTION_KEY, `secret:${name}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
};

const stores: Record<string, SecretStore> = { env: envSecretStore, "aws-sm": awsSecretStore, local: localSecretStore };

/** Writes (or replaces) a secret the platform owns and returns its reference. */
export async function storeSecret(name: string, value: string): Promise<string> {
  if (env().SECRETS_DRIVER === "aws") {
    const id = `creatorfarm/${env().APP_ENV === "production" ? "prod" : env().APP_ENV}/${name}`;
    smClient ??= new SecretsManagerClient({});
    try {
      await smClient.send(new CreateSecretCommand({ Name: id, SecretString: value }));
    } catch (err) {
      if (!(err instanceof ResourceExistsException)) throw err;
      await smClient.send(new PutSecretValueCommand({ SecretId: id, SecretString: value }));
    }
    secretCache.delete(id);
    return `aws-sm:${id}`;
  }
  if (env().APP_ENV === "production") throw new Error("Production secrets must be written to the secrets manager");
  await mkdir(localDir(), { recursive: true, mode: 0o700 });
  await writeFile(localFile(name), encrypt(value, env().APP_ENCRYPTION_KEY, `secret:${name}`), { mode: 0o600 });
  return `local:${name}`;
}

/** Removes a platform-owned secret (AWS keeps it recoverable for 7 days). */
export async function deleteSecret(ref: string): Promise<void> {
  const { scheme, name } = parseSecretRef(ref);
  if (scheme === "local") await rm(localFile(name), { force: true });
  else if (scheme === "aws-sm" && env().SECRETS_DRIVER === "aws") {
    smClient ??= new SecretsManagerClient({});
    await smClient.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: 7 })).catch((err) => {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    });
    secretCache.delete(name);
  } else throw new Error(`Secrets of type ${scheme} are not owned by the platform`);
}

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
