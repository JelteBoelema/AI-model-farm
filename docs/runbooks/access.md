# Runbook: access

- **New person**: the owner adds them under **Settings → Users** with the lowest role that fits. In production, owners and admins must set up two-factor authentication at their first sign-in; until they do, they can only reach the setup page.
- **Lost phone**: sign in with a recovery code, then *Account → Two-factor authentication → New recovery codes*, or turn it off and set it up again. Without recovery codes, the owner uses *Reset 2FA* on the Users page, with a reason. The reset is audited, and the person sets up again at the next sign-in. The only owner cannot reset their own: keep a second owner, or restore the owner's access through the database (`UPDATE users SET mfa_secret = NULL, mfa_enabled_at = NULL, mfa_recovery_codes = '{}' WHERE email = …`), recorded as an incident.
- **Leaving**: disable the user (not delete), so the audit trail keeps the name. With SSO, also remove them at the identity provider.
- **Single sign-on** (optional): set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (secret in Secrets Manager), and as redirect URI register `https://<domain>/api/auth/callback/oidc`.
  - Only people who already have an account here, with the same verified email, can sign in. Roles stay in this app.
  - Set `OIDC_IDP_ENFORCES_MFA=true` only when the identity provider enforces a second factor for every user. Otherwise owners and admins still set up two-factor authentication here.
