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

Contributors can test the current ixtable codebase from the repository root:

```shell
npm test
```

The screenshot suite renders the real React app, drives its controls, and captures checked states:

```shell
npm run screenshot
```

These commands test ixtable itself. They do not test a user-created ixtable project.

## Next steps

- [Data view](./data-view.md)
- [Design view](./design-view.md)
- [Deployment](./deployment.md)
