---
sidebar_position: 2
---

# Design view

_Design view is a work-in-progress interface for building the app that sits on top of project data._

The current prototype has a component library, a form canvas, and a properties panel. It also previews the inventory app without leaving the project.

:::warning Work in progress

This page is a documentation stub. The design model and editing behavior can change while the feature is under development.

:::

![The form builder prototype in Design view](../assets/design-view.png)

## Form builder

The **form builder** arranges controls on a canvas and exposes settings for the selected control. The component library is the source for new controls. The properties panel edits their configuration.

:::note TODO

Document component placement, data binding, properties, layout rules, undo, and project persistence after the behavior is implemented.

:::

## App preview

Preview mode renders the current design as an inventory app with metrics, search, filters, and product records. It gives the design a runtime-shaped surface for review.

![The generated runtime preview for the inventory app](../assets/app-preview.png)

:::note TODO

Connect preview state to saved form definitions and project data. Document the boundary between preview and a deployed app.

:::

## Next steps

- [Data view](./data-view)
- [Testing](./testing)
- [Deployment](./deployment)
