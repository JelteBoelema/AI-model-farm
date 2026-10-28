// Edge-safe Auth.js configuration (no database or bcrypt imports): used by middleware.
import type { UserRole } from "@prisma/client";
import type { NextAuthConfig } from "next-auth";

export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = Boolean(auth?.user);
      if (request.nextUrl.pathname.startsWith("/login")) {
        return isLoggedIn ? Response.redirect(new URL("/", request.nextUrl)) : true;
      }
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user?.id) {
        token.uid = user.id;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.uid === "string") session.user.id = token.uid;
      // How this session signed in ("password" or "sso"), for the two-factor requirement.
      if (typeof token.via === "string") (session.user as { via?: string }).via = token.via;
      if (typeof token.role === "string") session.user.role = token.role as UserRole;
      return session;
    },
  },
} satisfies NextAuthConfig;
