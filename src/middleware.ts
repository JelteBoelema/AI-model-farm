import NextAuth from "next-auth";
import { authConfig } from "@/server/auth/config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  runtime: "nodejs",
  // API routes perform their own authentication and return 401 instead of redirecting.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp)$).*)"],
};
