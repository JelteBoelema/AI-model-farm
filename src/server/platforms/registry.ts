// Which adapter serves an account. Mock-mode connections use the mock platform; real Instagram
// publishing needs the Meta app (App ID/secret in the secrets manager) and its verified adapter.

import type { Platform } from "@prisma/client";
import { env } from "../env";
import { DomainError } from "../errors";
import { MockPlatformAdapter } from "./mock";
import type { PlatformAdapter } from "./types";

const mock = new MockPlatformAdapter();
const overrides = new Map<Platform, PlatformAdapter>();

/** Tests may register a stand-in for a real platform. */
export function registerPlatformOverride(platform: Platform, adapter: PlatformAdapter | null) {
  if (adapter) overrides.set(platform, adapter);
  else overrides.delete(platform);
}

export const SUPPORTED_PLATFORMS: Platform[] = ["INSTAGRAM"];

export function platformAdapter(platform: Platform, isMock: boolean): PlatformAdapter {
  if (isMock) return mock;
  const override = overrides.get(platform);
  if (override) return override;
  if (platform === "INSTAGRAM")
    throw new DomainError("The real Instagram integration is enabled once the Meta app is set up and verified (see open actions); use mock mode until then");
  throw new DomainError(`${platform.toLowerCase()} publishing is not available yet`);
}

/** Adapter for a new connection: mock mode always connects to the mock platform. */
export function connectAdapter(platform: Platform): PlatformAdapter {
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw new DomainError(`${platform.toLowerCase()} is not supported yet; Instagram comes first`);
  return platformAdapter(platform, env().MOCK_MODE && !overrides.has(platform));
}
