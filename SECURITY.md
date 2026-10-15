# Security Policy

## Supported versions

Security fixes go into the latest release only and ship as a new patch release
of that minor line. Older releases are not patched.

| Version | Supported |
|---------|-----------|
| Latest release (`vX.Y.Z` tags, see [Releases](https://github.com/babbguy/Nomus/releases)) | Yes |
| Older releases | No |
| `develop` and `main` between releases | Fixes land here first |

## Reporting a vulnerability

Please report security issues privately. **Do not open a public issue for a
security problem.**

Use GitHub private vulnerability reporting:
<https://github.com/babbguy/Nomus/security/advisories/new>. This covers every
part of Nomus, including the GitHub Action published from
[babbguy/nomus-action](https://github.com/babbguy/nomus-action).

Include the affected component and version, a description of the issue, and
steps to reproduce where possible.

Nomus has a single maintainer, so set expectations accordingly:

- Reports are usually acknowledged within 7 days.
- An assessment, and a fix or mitigation plan for a confirmed issue, follows as
  soon as practical, typically within 30 days. There is no guaranteed response
  or fix time.
- Please allow time for a fix before disclosing publicly. The fix is announced
  in a GitHub security advisory, and reporters are credited if they wish.

## Verifying releases

Starting with v1.2.0, every release is built and published by GitHub Actions
from its `vX.Y.Z` tag, and you can check what you install against that build.

### Container images

Each `ghcr.io/babbguy/nomus-engine` and `ghcr.io/babbguy/nomus-dashboard` image
is signed with [cosign](https://docs.sigstore.dev/) using the publish
workflow's GitHub identity (keyless; no key to distribute), and has a SLSA
build provenance attestation and an SPDX SBOM for each platform. The
signature and the attestation cover the image's multi-platform digest, which
the tag resolves to and which includes the SBOMs.

Signature (cosign v3 or later; substitute the version in both places):

```bash
cosign verify ghcr.io/babbguy/nomus-engine:1.2.0 \
  --certificate-identity https://github.com/babbguy/Nomus/.github/workflows/publish.yml@refs/tags/v1.2.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Build provenance ([GitHub CLI](https://cli.github.com/), signed in with
`gh auth login`):

```bash
gh attestation verify oci://ghcr.io/babbguy/nomus-engine:1.2.0 -R babbguy/Nomus
```

Add `--signer-workflow babbguy/Nomus/.github/workflows/publish.yml` to also
require that the release workflow produced it.

SBOM (SPDX JSON) of one platform:

```bash
docker buildx imagetools inspect ghcr.io/babbguy/nomus-engine:1.2.0 \
  --format '{{ json (index .SBOM "linux/amd64").SPDX }}'
```

The same commands work for `nomus-dashboard`. To deploy exactly what you
verified, pin the image by the digest that `cosign verify` prints.

### npm packages

`nomus-scan` and `nomus-mcp` are published with npm trusted publishing and carry
a provenance attestation that links each version to its source commit and
workflow run. In a project that depends on them:

```bash
npm audit signatures
```

checks the registry signatures and provenance attestations of every installed
package, including these two. The npm page of each version also shows its
provenance.

## Scope notes

- Nomus is designed to be self-hosted. Securing a deployment (secrets, TLS,
  network exposure, backups) is the operator's responsibility; see
  `docs/admin-guide/deployment.md`.
- Output from Nomus is regulatory applicability information, not legal advice.
  An incorrect or missing rule is a data-quality issue, not a vulnerability;
  please file those as regular issues.

## Known advisories

### react-router: RSC-mode CSRF advisory (GHSA-qwww-vcr4-c8h2)

An advisory affects `react-router` 7.12.0 to 7.18.1 in its React Server Components
(RSC) mode, and the lockfile currently resolves 7.18.1. Nomus is not exposed to
the described issue in practice: the dashboard is a **client-only Vite
single-page application** (`BrowserRouter`), with no React Server Components and
no server-side rendering request path.

**Status:** `npm audit` reports that a fix is available via `npm audit fix`; the
lockfile has not been updated yet.

### Other dependency advisories

`npm audit` also reports advisories against other (mostly transitive)
dependencies. They are not individually listed or assessed here. Run `npm audit`
in a checkout for the current list, and report anything you believe is
exploitable through Nomus using the process above.
