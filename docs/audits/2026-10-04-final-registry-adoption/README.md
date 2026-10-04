# Move: published SDK adoption

Source `1ea2afdbc25807eb72296c032c81e16777e2dec1` pins the published SDK and its measured compatible Bloom version, including the regenerated lockfile. Existing application behavior and previously reviewed fixes remain in the branch.

Validation: {"backendPassed": 82, "frontendPassed": 11, "sdkImporterMembers": 3976, "bloomImporterMembers": 20940, "typesBuildExportGates": "passed"}. Exact commands, logs, archive member hashes and importer resolutions are in [proof.json](proof.json).

- Published registry archives and all installed SDK importer members were compared byte for byte. Stale same-version candidate materializations were retained and repaired with a frozen install; their setup failures remain in the records.
- Local web export proves compilation, not browser/native acceptance or deployed public-client configuration. Required PR/main CI and root image/promotion remain separate.
- No production database, provider writes, grants, credentials or auth fixtures were changed. Owned PostgreSQL was stopped and its PID absence verified.
- Initial run used Bun 1.3.14 and returned 82 passes plus a socket teardown hook timeout. Canonical CI Bun 1.4.2 completed 82/0 after retained overlay links were replaced with normal registry materialization. This is not a runtime product change.
- The former overlay targets were not modified; only owned node_modules links were moved aside. All final resolvers remain within this worktree and match the public archives.
