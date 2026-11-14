# Move first-party platform migration

Source-only work, 2026-10-23. No deployment or production database mutation is
claimed. The own service carries identity, not OAuth scopes or a customer key.

Move's one `OxyServer` (`packages/backend/src/oxy.ts`) verifies sessions and is
its service identity; it uses the shared AWS role provider, including temporary
local SSO roles. Mention's SDK owns its canonical audience, authenticated
transport and schemas. Move retains batch byte limits, ordering, source SSRF
protection, fleet media budget, pause-on-429, checkpoints and idempotent undo.

## Acting for people (oxy ADR 0066)

Oxy's own services never ask people for permissions, tasks or consent. Move's
entry in [Oxy's first-party registry](https://github.com/OxyHQ/oxy/blob/main/packages/api/src/scripts/seedOxyApplicationsSpecs.ts)
declares what it does for the people who move: `oxy:files` write (post and
avatar media), `oxy:linked-accounts` read (the account they move from) and
Mention write (the posts). Every linked-account read, Files import and Mention
call names the job's account with `actingFor` and nothing else; Oxy checks the
declaration and the account live on each call, in the foreground and in the
background alike. A job stores no authority, so nothing expires or is renewed.

Move moves a person's own account: starting, previewing or undoing a job is
refused when the session's actor is not the account it is in. Cancel and undo
stop the runner through the job's status (every save is conditional on an
active job); undo deletes the original batch, and the runner deletes it again
if a delivery was in flight. If Oxy no longer admits the account (closed,
supervised), the run fails with `authority-unavailable` and keeps its partial
work. The off switch is the person's: cancel or undo the job.

`oxy_task_id` and `undo_task_id` leave in two steps. The schema stops naming
them first, so the image that rolls out never selects them; the generated
`DROP COLUMN` follows in its own change, marked `pre`, once that image is live.
A `post` marker would not work here: `/ready` refuses traffic until every
migration in the image's journal is applied, and `post` runs only after the
rollout is healthy. Production had one job ever, on a personal account, with
neither column set (read-only check, 2026-11-14).

## Alia client transport

The frontend asks Alia through the published `@gemies/sdk` (`GemieChatSheet`), which
talks to `https://api.gemies.ai`. Gemies owns conversation, history, streaming and audio
transport through the shared Oxy session; the app keeps its existing provider,
agent selection and UI. No app-local bearer refresh or internal permission prompt
is introduced.

## Browser job progress

Job progress sockets resolve each handshake through the provider's linked Oxy
client and its target-bound `getAccessToken`. They keep no bearer cache or local
refresh loop. An Oxy account/session-context change immediately aborts pending
handshakes, disconnects the existing socket and removes its listeners before a
new subscription starts. Old progress events cannot update the next viewer's
cache. A same-session token refresh retains the connection.

The frontend Socket.IO integration test uses real HTTP/WebSocket connections to
check expired-token refresh, a connected account switch, sign-out, disposal and
switch/disposal during a blocked refresh. These changes do not affect migration
job authority or external account linking.
