---
sidebar_position: 3
---

# Testing

_Testing support inside ixtable is planned and not implemented._

This page reserves the documentation structure for project-level tests. The repository already tests the ixtable application itself, but an ixtable project cannot define or run its own test suite yet.

:::warning Work in progress

Testing is a documentation stub. There is no testing workspace in the app.

:::

## Planned scope

Project tests should cover data rules and designed workflows. The exact test model, runner, and result format are still open.

:::note TODO

Define the test file format, fixtures, assertions, runner, result history, and continuous integration interface.

:::

## Repository tests

Contributors can test the ixtable codebase from the repository root. `npm test` first builds the Rust core as a Node module, then runs the unit tests and the integration tests. Integration tests render the real interface and send every command to the real Rust code.

```shell
npm test
cd src-tauri && cargo test --lib
```

The screenshot suite renders the real React app, drives its controls, and captures checked states:

```shell
npm run screenshot
```

Continuous integration runs these suites on Windows, macOS, and Linux, plus a PostgreSQL conformance suite on Linux. These commands test ixtable itself. They do not test a user-created ixtable project.

## Next steps

- [Data view](./data-view)
- [Design view](./design-view)
- [Deployment](./deployment)
