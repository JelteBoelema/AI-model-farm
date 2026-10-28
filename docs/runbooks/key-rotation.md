# Runbook: keys and secrets

All secrets are in AWS Secrets Manager under `creatorfarm/<env>/…`, replicated to `eu-west-1`. Terraform creates them empty; values are only set through the CLI or the console:
```sh
aws secretsmanager put-secret-value --secret-id creatorfarm/prod/<name> --secret-string '…'
```
After every change: `aws ecs update-service --force-new-deployment` for web and workers (containers read secrets at start).

| Secret | Rotate | Effect |
|---|---|---|
| `auth-secret` | yearly, and after a suspected leak | everyone is signed out |
| `encryption-key` | only on a leak: **re-encrypt first** (two-factor secrets and local secret files use it) | without re-encryption, two-factor authentication must be reset for everyone |
| `database-url` | with the RDS master password (RDS manages it; rotation in RDS, then rebuild this URL) | brief reconnects |
| `anthropic`, `openai`, `google-genai`, `elevenlabs` | every 90 days, and immediately on a leak | none, if the new key is set before the old one is revoked |
| `meta-app` | on a leak (Meta app → reset app secret) | token refreshes need the new secret |
| `social/<account>` | managed by the app (OAuth refresh) | — |

## Credential leaked
1. Pause what uses it: the provider (AI Providers → disable) or **All publishing**.
2. Revoke at the source (provider console, Meta app), create a new key, `put-secret-value`, force a new deployment.
3. Check the cost ledger and the provider's usage page for use after the leak time; check the audit log.
4. Re-enable, and record the incident (`incident.md`).
