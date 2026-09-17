# Hosted deployment acceptance

This records a scoped live run on 2026-09-17. The fixture was a dedicated private GitHub repository with a Node HTTP service and a PostgreSQL marker table, containing no customer data. It used a Linux ARM64 home machine for both build and runtime, with explicit database placement. It does not establish readiness of other customer networks.

## Observed results

- GitHub App access cloned a pinned commit from the private repository.
- Railpack detected Node, BuildKit built the image on the matching ARM64 builder, and the immutable image uploaded to the R2-backed registry.
- Nomad scheduled the application on the selected machine. Its health check passed before service routing changed.
- PostgreSQL provisioned on that same explicit machine. An authenticated database probe completed before the connection could be attached.
- The application's private HTTP response included its version and the marker read from PostgreSQL.
- Enabling daily backups persisted the schedule and triggered a real dump/upload job. Both tasks completed successfully and the hosted controller recorded a checksum-verified R2 snapshot.
- Restoring that snapshot created a separate PostgreSQL instance and volume. Download, checksum verification, transactional restore, and authenticated query completed. A direct query of the restored instance returned the original marker. The source application continued serving its original database.

The first backup attempt exposed a real Nomad interpolation error: shell parameter expansion in a Docker argument was parsed as a Nomad expression. Checksum extraction now uses `cut`, and the subsequent scheduled backup and restore succeeded on the actual runtime. The workerd tests also guard against reintroducing shell parameter expansion in that command.

- An intentionally unhealthy commit built successfully but failed the deployment health deadline. The controller rejected it and retained the previous deployment; the original endpoint still returned its version and database marker.

- A second healthy source version deployed and returned the same marker. Rolling back to the first release reused its immutable image without clone/build steps; the resulting healthy endpoint returned the original application version and unchanged marker.

## Remaining acceptance steps

The dedicated public HTTPS address awaits user confirmation before exposure. All application/database/backup/rollback steps above were observed live; do not treat the complete public journey as proven until HTTPS is checked externally.

## Reproduction outline

1. Create a private fixture repository whose health response reads a persistent marker from `DATABASE_URL`.
2. Select a ready builder matching the runtime architecture and explicitly select the application's machine.
3. Provision and attach a database; deploy the pinned source commit and verify the returned marker.
4. Add a dedicated test hostname and verify HTTPS externally.
5. Enable backups, observe a successful real dump/upload, restore into a new database, and query its marker without changing the original binding.
6. Deploy an intentionally unhealthy version; verify the previous version and its marker remain available.
7. Deploy a second healthy version and roll back to the original immutable image without a rebuild. Verify the marker is unchanged.

Keep operational IDs, addresses, logs and any credentials outside the repository. The isolated PostgreSQL smoke suite and actual local workerd checks provide complementary regression coverage, not evidence that the live provider path is working.
