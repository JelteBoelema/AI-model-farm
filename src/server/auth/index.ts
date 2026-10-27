import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./config";
import { authenticate } from "./credentials";

class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials, request) {
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const outcome = await authenticate(credentials, { ip, userAgent: request.headers.get("user-agent") });
        if (outcome.ok) return outcome.user;
        if (outcome.reason === "rate_limited") throw new RateLimitedSignin();
        return null;
      },
    }),
  ],
});
