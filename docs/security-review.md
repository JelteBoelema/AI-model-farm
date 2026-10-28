# Security review (phase 10)

An internal review against OWASP ASVS 4.0 level 2 (the relevant chapters), with automated checks wherever possible. It is **not** an external penetration test. That remains an open action before go-live (`open-actions.md`).

Date: 28-10-2026. Scope: web app, workers, data stores, AWS infrastructure (Terraform), CI/CD.

## Method
1. Threat model (`security.md`) checked against the code as built.
2. Automated checks, which run in CI on every change:
   - **Dependencies**: `pnpm audit --prod --audit-level high`, Dependabot.
   - **Containers**: Trivy scan of each image (fixable high or critical findings block the build).
   - **Secrets**: gitleaks over the full git history.
   - **Code**: CodeQL (`security-extended`).
   - **Infrastructure**: Checkov on Terraform and the Dockerfile (0 failures; every exception is documented in the code with `#checkov:skip` and a reason).
   - **Behaviour**: tests for authorisation, agent paths, rate limits, MFA, SSO admission, headers (e2e) and alarms.
3. Manual review of every place where input enters (server actions, API routes, OAuth callback, uploads, provider and platform responses) and every place where something leaves (provider calls, media serving, publishing).
4. Load test (`drills.md`). It surfaced one robustness defect (F1).

## Controls verified

| Area | Control | Evidence |
|---|---|---|
| Authentication | Passwords hashed with bcrypt. Sign-in limited per address and account (5 per 15 minutes), counting failed second-factor codes too | `tests/integration/auth.test.ts`, `security.test.ts` |
| | Two-factor authentication: TOTP per RFC 6238, secret encrypted with AES-256-GCM, one use per code (replay refused), 10 single-use recovery codes stored as keyed hashes. Required for owners and admins in production; until set up, the user can only reach the setup page | `tests/unit/totp.test.ts` (RFC vectors), `security.test.ts`, `e2e/mfa.spec.ts` |
| | Optional SSO (OIDC with PKCE, state and nonce): only existing, enabled accounts with a verified email; never creates accounts; roles stay local | `security.test.ts` |
| | Sessions: JWT valid for 8 hours. Role and disabled state are re-read on every request, so revocation is immediate | `session.ts` |
| Authorisation | Every server action goes through `defineAction(permission, schema)`. The three exceptions (sign-in, sign-out, own two-factor settings) only act on the user's own account | `rbac.test.ts`, `grep "use server"` |
| | Limits, budgets, autonomy, provider settings, account links and users can only be changed by a person (`assertHuman`), whatever role an automated actor claims | `autonomy.test.ts` (17 mutations) |
| | API routes: authentication, permission, and an MFA check where needed | route handlers |
| Input | Zod validation on every action. Uploads are checked on content (magic bytes) and size. Templates are rendered with only the declared variables | phases 2–5 |
| | No raw SQL, apart from the fixed load-test and drill scripts | `grep queryRawUnsafe` |
| CSRF / redirects | Server actions: Next.js origin check. Auth.js CSRF token. OAuth: state bound to the user, single use, PKCE S256. Redirects only go to fixed paths on the app's own origin | `social.ts`, callback route |
| XSS | React escaping. No user HTML. Content-Security-Policy without external sources, `frame-ancestors 'none'`, `object-src 'none'` | `next.config.ts`, `e2e/mfa.spec.ts` |
| SSRF | Provider and platform calls only go to fixed hosts. Media downloads from Veo use a host allowlist | `google-veo.ts` |
| Secrets | Only in Secrets Manager (production) or encrypted local files; the database only references them. Audit metadata is scrubbed. No secrets in Terraform state (the RDS password is managed by RDS) | `secrets.ts`, `data.tf` |
| Rate limiting | WAF: 2,000 requests per 5 minutes per address, plus 100 sign-ins per 5 minutes. App: 120 actions per minute per user, 300 API calls per minute per address, 10 two-factor attempts per minute per account | `edge.tf`, `rate-limit.ts`, `security.test.ts` |
| Network | Only the ALB is public (TLS 1.2+, HTTP redirected). Tasks, database and Redis sit in private subnets. Outbound traffic only on 443, DNS and the data ports. VPC flow logs | `network.tf` |
| Data at rest | KMS encryption for RDS, ElastiCache, S3, log groups and secrets. TLS enforced to RDS (`rds.force_ssl`), Redis and S3 | `data.tf` |
| Logging | Append-only audit trail (database triggers, preserved after a restore). WAF logs with cookies and authorisation headers redacted | restore drill, `edge.tf` |
| Supply chain | Lockfile with `--frozen-lockfile`; versions pinned; images built in CI and pushed by SHA; deploy through GitHub OIDC with a role scoped to this repository's production environment | `ci.yml`, `deploy.tf` |

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | At high volume, our own per-provider request limit made content steps **fail** instead of wait. 146 of 300 items stopped in the load test | medium (availability) | **Fixed**: the step goes back to waiting for the next minute window (spread out) without using an attempt; nothing was sent or billed. Test in `autonomy.test.ts` |
| F2 | Known vulnerabilities in dependencies of dependencies: `postcss` (via Next.js, build time) and `deepmerge-ts` (via the Prisma CLI) | high (according to the advisories) | **Fixed**: pinned to patched versions (`pnpm.overrides`); `pnpm audit` is clean |
| F3 | Redis has no AUTH token. Access is limited to the tasks' security group, with TLS | low | **Accepted**: a token would end up in Terraform state. Plan: ElastiCache RBAC with IAM authentication |
| F4 | The CSP allows inline scripts (`'unsafe-inline'`): Next.js hydration needs them without per-request nonces | low | **Accepted**: no user HTML is ever rendered. Plan: nonce-based CSP |
| F5 | Every signed-in user can fetch every media object (`/api/media/...`) | low | **Accepted**: one team, and all roles may view media. Keys are not guessable (UUIDs) |
| F6 | Two-factor authentication is not required for operators and viewers | low | **Configurable**: `MFA_REQUIRED_ROLES=OWNER,ADMIN,OPERATOR,VIEWER` |
| F7 | Rate limits use a fixed window: twice the limit is possible at a window boundary | info | Accepted. The WAF covers the edge |
| F8 | No external penetration test yet | — | **Open action** before go-live |

## Re-test
After every release: the CI checks. Quarterly: the restore and alarm drills (`docs/runbooks/drills.md`). Yearly, and after large changes: an external pentest.
