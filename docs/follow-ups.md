# Follow-ups outside Move

Work Move needs from other repos. Each item names the owner; Move does not
build app-side stand-ins for them.

## Mention: reference the media of imported posts (ADR 0043)

Move imports a post's media into the user's Oxy files and hands Mention the
file ids (`media[].assetId` on `POST /imports/v1/posts:batch`). Mention is the
application that USES them, so Mention registers
`OxyServer.assets.references.add([{ fileId, entityType: 'post', entityId }])`
when it creates the post, removes them when it deletes the post (a user's
delete, and `DELETE /imports/v1/batches/:jobId`), and reconciles them. It is
the "references for post media" item of ADR 0043's stage 3 for Mention, and
needs `files:references:write` on Mention's Oxy application. Until then
imported media read as *not in use* in the user's file manager (never deleted:
they are the user's files). See [`oxy-files.md`](oxy-files.md).

## Oxy: reference a profile's avatar when it is set (ADR 0043)

The Move client sets the migrated avatar with `users.updateMe({ avatar })`.
Oxy's `PUT /users/me` makes the file public but records no reference, so the
avatar reads as *not in use* in the user's file manager. The profile is Oxy's
entity: Oxy should reference the avatar (and banner) file under the profile
when it is set and remove it when it is replaced, for every app, not only
Move. `assets.uploadAvatar` links its own uploads from the client; a file
imported by a backend gets no such link.
