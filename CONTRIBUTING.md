# Contributing to Agent-2D

Contributions are welcome. Bug reports, feature requests, documentation improvements, and focused pull requests are appreciated.

Agent-2D is a local-first image-processing project with shared Rust core logic used by the desktop app, CLI, and MCP server. Changes can therefore affect more than one interface. Please keep pull requests small and reviewable, and preserve existing behavior unless the change explicitly intends to modify it.

## Before you start

- Search existing Issues before opening a new one.
- For substantial features, architecture changes, new runtime dependencies, or breaking behavior, open an Issue first and discuss the approach.
- Issues labeled `good first issue` are intended to be approachable without deep knowledge of the internals.
- Issues labeled `help wanted` are scoped work where outside contributions are especially useful.

## Development setup

### Requirements

- Apple Silicon macOS for the primary desktop target (the current release-validation environment)
- Rust 1.87+
- Node.js 20+
- Xcode Command Line Tools

### Install dependencies

```bash
# Desktop
cd apps/desktop
npm ci

# MCP server, when working on MCP code
cd ../../mcp/server
npm ci
```

From the repository root, Rust dependencies are managed through the Cargo workspace.

## Branches, commits, and pull requests

1. Branch from the latest `main`.
2. Keep one pull request focused on one problem.
3. Use clear commit messages that describe the change rather than the editing process.
4. Avoid unrelated cleanup, broad formatting-only changes, dependency churn, or large refactors in the same PR.
5. Do not silently break existing CLI, MCP, desktop, file-format, or output-naming behavior.
6. If a breaking change is necessary, call it out explicitly in both the Issue and PR.

Small PRs that can be reviewed and verified independently are strongly preferred.

## Validation

Run the checks relevant to the files you changed. A typical desktop/core change should include:

```bash
cargo check --workspace
cargo test --workspace

cd apps/desktop
npm run typecheck
npm run build
```

For MCP changes, also run:

```bash
cd mcp/server
npm run typecheck
npm run build
```

`npm run acceptance` exercises real CLI/MCP processing and can also exercise locally installed optional AI runtimes, so it may take substantially longer. Run it when your change affects MCP tool behavior, runtime parity, or processing contracts and note the result in the PR.

If a full workspace test is disproportionately expensive for a documentation-only or narrowly scoped change, state exactly what you did verify in the PR description.

## Pull request expectations

A PR should explain:

- what changed;
- why the change is needed;
- how it was verified;
- whether it introduces a breaking change;
- which Issue it relates to, when applicable.

Screenshots are useful for visible desktop UI changes. Do not include secrets, local credentials, model files, generated build artifacts, or unrelated personal files.

## Labels

The project uses the following contributor-facing labels:

- `good first issue` — bounded tasks suitable for a first contribution;
- `help wanted` — maintainers would welcome outside implementation help;
- `bug` — confirmed or reproducible incorrect behavior;
- `enhancement` — feature or UX improvement;
- `documentation` — README, guides, examples, or other documentation work.

Maintainers may add or adjust labels as an Issue becomes better understood.

## Large or risky changes

Please open an Issue before starting work that changes architecture, model/runtime selection, updater/release behavior, public CLI/MCP contracts, supported file formats, or major UI workflows. This keeps design discussion separate from implementation and avoids spending time on a direction that may not fit the project.
