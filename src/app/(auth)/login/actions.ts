"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/server/auth";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/",
    });
    return {};
  } catch (err) {
    if (err instanceof AuthError) {
      const code = (err as AuthError & { code?: string }).code;
      if (code === "rate_limited") return { error: "Too many attempts. Try again in a few minutes." };
      return { error: "Invalid email or password." };
    }
    throw err; // NEXT_REDIRECT on success
  }
}
