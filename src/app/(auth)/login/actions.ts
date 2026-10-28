"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/server/auth";

export interface LoginState {
  error?: string;
  /** The password was accepted; a second factor is needed. */
  mfa?: boolean;
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      otp: String(formData.get("otp") ?? ""),
      redirectTo: "/",
    });
    return {};
  } catch (err) {
    if (err instanceof AuthError) {
      const code = (err as AuthError & { code?: string }).code;
      if (code === "rate_limited") return { error: "Too many attempts. Try again in a few minutes." };
      if (code === "mfa_required") return { mfa: true };
      if (code === "mfa_invalid") return { mfa: true, error: "That code is not valid. Use the current code from your app, or a recovery code." };
      return { error: "Invalid email or password." };
    }
    throw err; // NEXT_REDIRECT on success
  }
}

export async function ssoSignInAction(): Promise<void> {
  await signIn("oidc", { redirectTo: "/" });
}
