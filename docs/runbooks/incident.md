# Runbook: incident

1. **Contain first.** If content or money is at risk, pause under **Settings → Controls**: *All generation* and/or *All publishing*, with the incident in the reason. Pausing is instant, safe and audited. Scheduled posts wait and nothing is lost.
2. **Find the scope.** Check the alarm (see `alarms.md`), the Workflow Monitor (queues, dead letters, worker heartbeats) and **Settings → Audit log** around the start time.
3. **Communicate.** Tell the owner what is paused, what is affected (creators, accounts, spend) and when the next update comes.
4. **Fix**, using the specific runbook: `restore.md`, `deploy.md` (roll back) or `key-rotation.md`.
5. **Resume carefully.** An admin resumes the pause. Publications in `AWAITING_CONFIRMATION` are first verified with the platform; nothing is sent twice.
6. **Close.** Write down cause, impact, timeline and follow-ups. Note the incident number in the resume reason so it is in the audit trail.

Severity:
- **critical**: publishing wrong or unapproved content, a leaked credential, uncontrolled spend, data loss → immediately.
- **warning**: delays, a single account disconnected, a budget pause → same working day.
