# Contributing to dsh-Immunity-memory

Thanks for improving the project. This guide is intentionally short; the
architecture and data-model details live in [`docs/开发说明.md`](docs/开发说明.md).

## Before you start

- Use Node.js 22+ (24 recommended).
- Go 1.26+ is only needed when changing `go-service/`.
- Rust stable is only needed when changing `native/memory-core/`.
- Run the plugin inside a DSH desktop profile to test the UI and the host
  integration. A plain Node process cannot render the sidebar page.
- Never commit a real memory database, a backup, a token, or a personal path
  from your machine.

## Setup

```pwsh
git clone https://github.com/theBeautifulIce/dsh-Immunity-memory.git
cd dsh-Immunity-memory
node scripts/check.mjs
```

If you change a native component, rebuild it before testing:

```pwsh
node scripts/build-go.mjs
node scripts/build-native.mjs
node scripts/check.mjs
```

## Workflow

1. Open an issue or describe the change in the PR; for user-visible behavior,
   include the expected interaction and the failure case.
2. Create a feature branch from `main`:
   `git switch -c feat/short-description`.
3. Keep changes focused. Do not mix refactors, formatting, and behavior
   changes in one PR unless they are inseparable.
4. Add or update tests for every behavior change, including a regression test
   for a bug.
5. Run the full self-check:
   `node scripts/check.mjs`.
6. Update documentation when you change a setting, tool, API, schema, layer
   semantic, or UI flow. Relevant files:
   `README.md`, `README.en.md`, `docs/开发说明.md`,
   `docs/design/记忆插件实现设计.md`, and `CHANGELOG.md`.
7. Rebuild the Windows binaries only when native/Go source changed. Mention
   the rebuild in the PR.

## Commit style

Use a typed summary in the repository's existing style:

```text
feat: add per-project memory spaces
fix: expire L6 entries on read
docs: document template layers
test: cover TTL_REQUIRED on update
refactor: split retrieval fusion
chore: rebuild Go service
```

Keep the subject under ~72 characters. Explain *why* in the body when the
change is not obvious.

## Code conventions

- Node code is ESM (`"type": "module"`); no build step for the plugin or UI.
- Prefer small, named functions and explicit data shapes.
- Keep the agent-facing API lossless JSON; formatting belongs in `client.js`.
- A mutable-layer write/update must require `ttlDays`; do not add a silent
  permanent default. Immutable L0/L1/L3 remain read-only unless an explicit
  maintenance/consolidation path is used.
- Templates carry only L0/L1/L3. Do not copy or delete L2/L4-L7 on a template
  switch.
- SQL migrations are append-only. Add a new version; never edit an applied
  migration.
- Do not add runtime npm dependencies without discussing it first. React is
  provided by the DSH host.
- Keep Windows, Linux, and macOS path handling in mind; use `path.join` and
  platform tags rather than hard-coded `\` or drive letters.

## Tests

The full suite covers:

- syntax checks for every JS module;
- engine CRUD, layers, TTL, conflict, consolidation, templates, and diff;
- Go-backed engine paths;
- tools, search fusion, SQLite migrations, native fallback, Go service API;
- HTTP API and client render tests.

Individual suites:

```pwsh
node tests/engine.test.mjs
node tests/engine-go.test.mjs
node tests/tools.test.mjs
node tests/search.test.mjs
node tests/sqlite.test.mjs
node tests/native.test.mjs
node tests/go-service.test.mjs
node tests/api.test.mjs
node tests/client.render.mjs
```

The render test currently needs the React copy from a DSH web profile; see the
header of `tests/client.render.mjs` if your profile lives elsewhere.

## Pull requests

A PR should include:

- what changed and why;
- user-visible behavior before/after (screenshots for UI changes);
- test evidence (`node scripts/check.mjs` output summary);
- migration/compatibility notes if the schema or public API changed;
- documentation and changelog updates.

Maintainers may ask for a smaller PR or a regression test before merging.
`main` must stay installable and green.

## Releases

1. Bump `packages/memory-plugin/package.json`.
2. Move `Unreleased` items in `CHANGELOG.md` under the new version and date.
3. Rebuild Go/Rust artifacts for the release platforms.
4. Run the full self-check on a clean checkout.
5. Commit, tag (`vX.Y.Z`), and publish release notes with the binaries.

## Security

Do not open a public issue for a vulnerability. Follow
[`SECURITY.md`](SECURITY.md).
