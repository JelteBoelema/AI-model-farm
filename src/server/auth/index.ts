import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { env, ssoConfigured } from "../env";
import { authConfig } from "./config";
import { authenticate } from "./credentials";
import { ssoUser } from "./sso";

class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}
class MfaRequiredSignin extends CredentialsSignin {
  code = "mfa_required";
}
class MfaInvalidSignin extends CredentialsSignin {
  code = "mfa_invalid";
}

function providers(): NextAuthConfig["providers"] {
  const list: NextAuthConfig["providers"] = [
    Credentials({
      credentials: { email: {}, password: {}, otp: {} },
      async authorize(credentials, request) {
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const outcome = await authenticate(credentials, { ip, userAgent: request.headers.get("user-agent") });
        if (outcome.ok) return { ...outcome.user, via: "password" };
        if (outcome.reason === "rate_limited") throw new RateLimitedSignin();
        if (outcome.reason === "mfa_required") throw new MfaRequiredSignin();
        if (outcome.reason === "mfa_invalid") throw new MfaInvalidSignin();
        return null;
      },
    }),
  ];
  const e = env();
  if (ssoConfigured(e)) {
    list.push({
      id: "oidc",
      name: e.OIDC_DISPLAY_NAME,
      type: "oidc",
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      clientSecret: e.OIDC_CLIENT_SECRET,
      checks: ["pkce", "state", "nonce"],
    });
  }
  return list;
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  ...authConfig,
  providers: providers(),
  callbacks: {
    ...authConfig.callbacks,
    // Single sign-on only admits people who already have an enabled account here; the role always
    // comes from this database, never from the identity provider.
    async signIn({ account, profile }) {
      if (account?.provider !== "oidc") return true;
      const user = await ssoUser({ email: profile?.email, emailVerified: profile?.email_verified as boolean | undefined, subject: profile?.sub ?? undefined });
      return user ? true : "/login?error=sso_denied";
    },
    async jwt(params) {
      const { token, user, account, profile } = params;
      if (account?.provider === "oidc") {
        const u = await ssoUser({ email: profile?.email, emailVerified: profile?.email_verified as boolean | undefined, subject: profile?.sub ?? undefined });
        if (!u) return null;
        token.uid = u.id;
        token.role = u.role;
        token.via = "sso";
        return token;
      }
      if (user && "via" in user) token.via = (user as { via?: string }).via;
      return authConfig.callbacks.jwt(params);
    },
  },
}));
