# MeetingRelay Windows distribution

R6 Windows distribution uses a Tauri NSIS installer configured for current-user
installation. Formal releases require Authenticode signing. Unsigned artifacts
are allowed only for an explicit `UnsignedTestBuild`.

## Formal release

```powershell
pnpm distribution:release -- -CertificateThumbprint <sha1>
```

or:

```powershell
pnpm distribution:release -- -CertificatePath C:\certs\meetingrelay.pfx
```

Without a certificate, the release script fails with
`MEETINGRELAY_DISTRIBUTION_SIGNING_REQUIRED`.

## Explicit unsigned test build

```powershell
pnpm distribution:release:unsigned-test
```

Unsigned test builds write a `.unsigned-test-build` sidecar marker and must not
be published as formal releases.

## Data retention contract

Upgrade, rollback, and default uninstall retain:

- `%LOCALAPPDATA%\MeetingRelay\mvp`
- Windows Credential Manager entries used for provider secrets

The NSIS hook file documents this contract and contains no deletion commands for
MeetingRelay local app data or Credential Manager secrets.

## Bundled resources

Non-dry-run distribution builds first run:

```powershell
powershell -ExecutionPolicy Bypass -File tools/distribution/Stage-DistributionResources.ps1
```

The staging step reuses the locked Sherpa target cache by default and verifies
model, token, runtime, lock, and license snapshot identities against
`tools/sherpa-native/assets.lock.json`. Missing cache assets fail with an
explicit `MEETINGRELAY_DISTRIBUTION_ASSETS_UNAVAILABLE` or
`MEETINGRELAY_DISTRIBUTION_STAGE_SOURCE_MISSING` error.

Generated resources are written to `apps/desktop/src-tauri/resources` and ignored
by git except for the directory README and `.gitignore`.
