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
      if (typeof token.role === "string") session.user.role = token.role as UserRole;
      return session;
    },
  },
} satisfies NextAuthConfig;
