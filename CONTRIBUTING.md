# Contributing to Nomus

Thanks for taking an interest. Nomus is a personal portfolio project, so
reviews happen on a best-effort basis, but well-scoped issues and pull requests
are welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the [Apache License 2.0](LICENSE).

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
```

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

## Commit and PR style

- Use conventional-style commit messages (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`) with a short imperative summary and, when useful, a body
  explaining why.
- Open pull requests against `main` and fill in the template.

## Reporting bugs and requesting features

Use the issue templates. For security problems, do not open a public issue; see
[SECURITY.md](SECURITY.md).
