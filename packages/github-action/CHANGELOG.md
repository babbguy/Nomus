# Changelog

## [1.0.0] - 2026-10-07

Initial public release of the `@nomus/github-action` package.

- Regulatory applicability scan on pull requests and pushes, using `@nomus/scanner` against a Nomus engine
- SARIF upload to GitHub Code Scanning
- Inline PR comments with obligation details and suggested fixes
- PR summary comment with regulatory weight breakdown and badge
- GitHub Check Runs with pass/fail annotations
- Regulatory exposure score and label as step outputs
- Configurable fail threshold (`critical`, `high`, `medium`, `low`)
- Fails closed when the Nomus engine is unreachable
- GitHub App manifest (`app-manifest.json`) for installation
