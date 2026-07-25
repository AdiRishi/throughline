# Desktop release operations

Throughline has one desktop release workflow: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
It deliberately separates portable packaging validation from a live updater
release. Both paths build the same four targets from the commit frozen during
preflight:

| Target      | Runner         | Installer                            |
| ----------- | -------------- | ------------------------------------ |
| macOS arm64 | `macos-15`     | `Throughline-<version>-arm64.dmg`    |
| macOS x64   | `macos-15`     | `Throughline-<version>-x64.dmg`      |
| Linux x64   | `ubuntu-24.04` | `Throughline-<version>-x64.AppImage` |
| Windows x64 | `windows-2025` | `Throughline-<version>-x64.exe`      |

Every downstream job checks out the full SHA emitted by preflight and verifies
`HEAD` before building. The collected artifacts also carry provenance with that
SHA, version, channel, platform, and architecture; the release job rejects a
mixed set.

## Versions and triggers

Stable versions are exactly `X.Y.Z`. Nightly versions are exactly
`X.Y.Z-nightly.YYYYMMDD.RUN`, where the date is a real UTC calendar date and
`RUN` is a positive integer. Prefixes, shortened versions, and other prerelease
suffixes are rejected.

- A pushed `vX.Y.Z` tag runs the unsigned validation path. A tag push never
  publishes a release.
- `workflow_dispatch` accepts either exact version shape. `publish=false`
  runs the same validation path.
- A live release requires `workflow_dispatch`, `publish=true`, and the default
  branch as the selected ref. Stable releases use `vX.Y.Z` and may become the
  repository's latest release. Nightlies use
  `vX.Y.Z-nightly.YYYYMMDD.RUN`, are prereleases, and never become latest.

Preflight runs `pnpm check` and `pnpm test` before either matrix starts.

## Validation artifacts are not releases

The validation matrix intentionally receives no signing credentials and no
updater repository. The packager disables signing discovery, emits only the
platform installer, emits no updater manifest or macOS update ZIP, and invokes
Electron Builder with `--publish never`. Each installer is uploaded only as a
seven-day GitHub Actions artifact.

These files are useful for installation and packaged-runtime smoke tests. They
are not distribution-ready:

- macOS validation artifacts are unsigned and unnotarized. They are not valid
  auto-update payloads and must not be attached to a GitHub Release.
- Windows validation installers are unsigned.
- No validation artifact contains a configured update feed.

This path is the expected result when production credentials are not available.
The workflow does not turn missing credentials into an apparently successful
public release.

## Production release gate

Configure a protected GitHub Actions environment named `production`. Require
reviewers there if the repository's release policy calls for human approval.
The production matrix runs only after an explicit `publish=true` dispatch and
uses `--signed --update-repository "$GITHUB_REPOSITORY"`. The packager still
uses `--publish never`: Electron Builder generates the payloads and metadata,
but only the final guarded job can create a GitHub Release.

Required `production` environment secrets:

| Secret                     | Target  | Purpose                                      |
| -------------------------- | ------- | -------------------------------------------- |
| `MAC_CSC_LINK`             | macOS   | Developer ID Application certificate and key |
| `MAC_CSC_KEY_PASSWORD`     | macOS   | Certificate archive password                 |
| `APPLE_API_KEY`            | macOS   | App Store Connect API private-key contents   |
| `APPLE_API_KEY_ID`         | macOS   | App Store Connect API key identifier         |
| `APPLE_API_ISSUER`         | macOS   | App Store Connect API issuer identifier      |
| `WINDOWS_CSC_LINK`         | Windows | Authenticode certificate and private key     |
| `WINDOWS_CSC_KEY_PASSWORD` | Windows | Windows certificate archive password         |

The build fails rather than degrading when a credential for its platform is
missing. After packaging:

- macOS must pass strict nested `codesign` verification, Gatekeeper assessment,
  and stapler validation for the app. Electron Builder notarizes and staples the
  app before placing it in the DMG; having secrets present is not treated as
  proof.
- Windows must report `Valid` Authenticode signatures on both the exact NSIS
  installer and the packaged application executable.
- Linux must produce an executable AppImage. AppImage does not provide the
  macOS/Windows platform trust model; it is included only after the two signed
  platform gates pass in the same production matrix.

The signed build emits update payloads while remaining non-publishing:

- macOS: architecture-qualified DMGs, ZIPs, ZIP blockmaps, and one per-architecture
  copy of `latest-mac.yml` or `nightly-mac.yml`.
- Windows: the NSIS installer, its blockmap, and `latest.yml` or `nightly.yml`.
- Linux: the AppImage (which carries its differential-update data internally)
  and `latest-linux.yml` or `nightly-linux.yml`.

The release job merges the two macOS manifests into the single channel manifest
expected by `electron-updater`. It then checks all four provenance records,
requires the exact platform assets, and verifies every manifest's version, URL,
size, and SHA-512 against the files about to be uploaded. Remote URLs,
subdirectories, missing assets, stale versions, and mismatched checksums all
fail closed. An existing GitHub Release is never overwritten.

Only after those checks does the workflow create the live GitHub Release and
attach installers, update payloads, blockmaps, and canonical manifests.

## Operating checklist

1. Confirm the default branch and ordinary CI are green.
2. Choose one exact stable or nightly version.
3. Run `Desktop Release` from the default branch with `publish=false`.
4. Install and smoke-test each Actions artifact on its target OS. On macOS,
   expect the validation build to be unsigned; this step does not test updates.
5. Confirm the protected `production` environment and all signing credentials.
6. Dispatch the same SHA, channel, and version with `publish=true`.
7. Approve the production environment when prompted.
8. Confirm all signature/notarization checks and manifest verification pass.
9. Download the resulting release assets and perform an update from the
   previous version on each supported platform.

If a production build fails while validation builds pass, inspect the
platform-specific signing output first. Packaging success does not establish
certificate trust or notarization, and the workflow intentionally keeps those
failure classes visible.
