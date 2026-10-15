# Contributing to Nomus

Thanks for taking an interest. Nomus is a personal portfolio project, so
reviews happen on a best-effort basis, but well-scoped issues and pull requests
are welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the project's license, the
[Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2).

## Contributor License Agreement

Before your first pull request can be merged, you need to sign the Contributor
License Agreement once. [CLA.md](CLA.md) is the reference copy of its text.

When you open a pull request, the CLA assistant bot
([cla-assistant.io](https://cla-assistant.io)) comments with a link to the
agreement. Follow the link, sign in with GitHub, and accept the agreement. The
same agreement covers Modus and Nomus, so one signature works for both. If the
text of the agreement changes, the bot asks you to sign the new version.

The `license/cla` check on a pull request stays pending until everyone who made
commits in it has signed. The bot can only match a commit to you if the commit's
email address is one of the addresses on your GitHub account.

### If your employer owns your contribution

Section 3(c) of [CLA.md](CLA.md) says: "If You are an employee, You have had
Your employer approve this Agreement or sign the Entity version of this
document." The entity version is [CLA-entity.md](CLA-entity.md). The bot cannot
collect an entity signature, so if your employer is going to sign it, open an
issue before you open your pull request and the maintainer will arrange it.

### Work you do not own

If a pull request includes material whose copyright you do not own (for example,
code copied from another project), say so in the pull request description: name
its source, its copyright holder and its license, and list the files that
contain it. A maintainer decides whether it can be accepted before the pull
request is merged.

## Getting set up

Requirements: Node.js 20.19+ (or 22.12+) and npm. CI runs Node 22.

```bash
git clone https://github.com/babbguy/Nomus.git
cd Nomus
npm install
npm run build:all
cp engine/.env.example engine/.env
npm run dev:engine        # API on http://localhost:3100
npm run dev:dashboard     # dashboard on http://localhost:5173
```

This is an npm workspaces monorepo: `engine/`, `dashboard/` and
`packages/{shared,scanner,chain,mcp-server,github-action,vscode-extension}`.
Run npm commands from the repository root. See the [README](README.md) for the
architecture overview.

## Before you open a pull request

Run the checks that CI runs:

```bash
npm run lint
npm run build:all
npm run test:engine
npm run test:extensions
npm run test:dashboard
```

- Run the release gate, `npm run gate` (see [e2e/README.md](e2e/README.md)). It runs the
  built product end to end and is a required check: a pull request cannot merge until the
  "Release gate" check passes. When a change legitimately alters its expected results, update
  `e2e/expectations.json` in the same pull request and explain why.
- Add or update tests for behavior you change.
- Keep changes focused; unrelated refactors belong in a separate pull request.
- If you change `packages/github-action`, rebuild its committed bundle with
  `npm run build:github-action` and commit `packages/github-action/dist/index.js`
  (JavaScript Actions run from the committed bundle). Do not commit source maps
  or other build output.
- Do not commit secrets, `.env` files or SQLite databases.

## Data and rules

Regulation text must stay faithful to the primary source. Do not paraphrase,
summarize or "clean up" stored regulatory text in code paths that ingest it. When
adding or changing a rule set, cite the source and the effective date from the
source, not the date the rule was seeded.

## Branches and releases

The project follows git flow:

| Branch | Purpose |
|--------|---------|
| `main` | Released code only. Every commit on `main` is a tagged release (`vX.Y.Z`). |
| `develop` | Integration branch and the repository's default branch. |
| `feat/<topic>`, `fix/<topic>` | Work branches, created from `develop` and merged back into it by pull request. |
| `release/X.Y.Z` | Created from `develop` to prepare a release (version bump, changelog), merged into `main` by pull request, tagged, then merged back into `develop`. |
| `hotfix/X.Y.Z` | Created from `main` for an urgent fix to a release, merged into `main` (tagged) and into `develop`. |

`main` and `develop` are protected: changes land only through pull requests whose
CI checks pass, and direct or force pushes are refused.

On the release branch, set the version in every package and add the `## [X.Y.Z]` section
to `CHANGELOG.md`:

```bash
npm version X.Y.Z --no-git-tag-version
npm version X.Y.Z --no-git-tag-version --workspaces
node scripts/check-version.mjs        # prints X.Y.Z when every package agrees
```

Pushing the `vX.Y.Z` tag runs two workflows. `release.yml` creates the GitHub release, with
the `CHANGELOG.md` section as its notes and the VS Code extension `.vsix` attached.
`publish.yml` pushes the `nomus-engine` and `nomus-dashboard` images to `ghcr.io`. Both
refuse a tag that does not match the package versions. The CI check "Release packaging"
runs the same packaging steps on every pull request.

## Commit and PR style

- Use conventional-style commit messages (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`) with a short imperative summary and, when useful, a body
  explaining why.
- Branch from `develop` (`feat/<topic>` or `fix/<topic>`), open pull requests against
  `develop`, and fill in the template.

## Reporting bugs and requesting features

Use the issue templates. For security problems, do not open a public issue; see
[SECURITY.md](SECURITY.md).
