# Move first-party platform migration

Source-only work, 2026-10-23. No deployment or production database mutation is
claimed. The own service carries identity, not OAuth scopes or a customer key.

`getServiceOxyClient` uses the shared AWS role provider, including temporary
local SSO roles. Mention's SDK owns its canonical audience, authenticated
transport and schemas. Move retains batch byte limits, ordering, source SSRF
protection, fleet media budget, pause-on-429, checkpoints and idempotent undo.

The verified session supplies the original operator and effective account when
a job is created. Oxy creates the durable goal; Move stores only `oxyTaskId`.
Every private linked-account read, Files import and Mention call carries its
original task/account proof. A service header cannot manufacture the account.
Managed accounts retain their human operator separately. Missing/revoked authority
stops the job without replacing the requester or deleting partial work.

Cancel revokes the original task before reporting success. Undo first stops the
old writer, then obtains a fresh 15-minute request from the current verified
session, persisting only `undoTaskId`. A compare-and-set prevents concurrent undo
requests from overwriting each other's authority; the original batch ID remains
unchanged, including cleanup after an in-flight delivery. Old completed history
has nullable proof fields and remains readable.

Deployment order: publish/pin Oxy core 7/contracts 6 and the new Mention SDK and
contracts; deploy Oxy's requester-protected linked-account/Files readers and
Mention's own import receiver; apply generated migration 0001 in the pre phase;
then deploy Move. Registry pins remain pending in this source checkpoint; local
candidate packages are validation only.

The root's read-only production census at 2026-10-23 19:31 UTC found one undone
job/items and no active jobs. Evidence: organization scratch
`first-party-root/move-counts-log.json`. Recheck immediately before cutover:
concurrent active legacy jobs cannot be silently given new authority. Preserve
them for an explicit current-session operation; never infer a requester from the
job owner or promote an old external credential. No production writes belong to
this source migration.

Validation against local candidate packages passed 139 backend tests, source
typecheck/build, Biome and repository gates. Tests use disposable PostgreSQL
and real shared SDK HTTP transport:
operator/effective account, revocation, cancellation, fresh undo, per-audience
workload mint, no persisted bearer, failed HTTP delivery retaining intent,
pause/retry, cursor resume and duplicate delivery. The finite Oxy legacy bridge
can retire only after all ecosystem producers are accounted for.
