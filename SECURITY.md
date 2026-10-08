# Security Policy

## Supported versions

Nomus is a portfolio project maintained on a best-effort basis. The latest
commit on `main` is the only supported version; fixes are not backported to
earlier commits or tags.

## Reporting a vulnerability

Please report security issues privately. **Do not open a public issue for a
security problem.**

Use GitHub private vulnerability reporting:
<https://github.com/babbguy/Nomus/security/advisories/new>

Include a description of the issue, the affected component, and steps to
reproduce where possible. Reports are handled on a best-effort basis; there is
no guaranteed response time. Please allow a reasonable period to investigate and
fix an issue before disclosing it publicly. Reporters are credited if they wish.

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
