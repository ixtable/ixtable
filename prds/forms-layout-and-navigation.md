# PRD: Shared Grid, Forms & Navigation

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide one renderer-agnostic layout system for forms and dashboards, and one form primitive system for generated and custom CRUD experiences.

## Shared grid model

The canonical layout is not raw CSS. It supports:

- rows and columns;
- fixed/content/fractional tracks;
- gaps and padding;
- spans;
- min/max sizes;
- alignment;
- named regions;
- breakpoints/wrapping;
- constrained interactive resize.

Desktop maps this schema to CSS Grid.

## Form capabilities

- text, number, boolean, date, time, and select controls;
- relationship selectors;
- labels/static text;
- validation messages;
- computed display values;
- conditional visibility/enabled state;
- sections and tabs;
- action buttons;
- list/detail/create/edit modes;
- one-level master/detail;
- related-record lists.

Generated CRUD must use exactly the same public primitives as hand-designed forms.

## Navigation

Applications can define a runtime navigation tree using stable object IDs.

Navigation entries may target forms, dashboards, reports, and supported actions. Runtime only exposes entries permitted by RBAC.

## Design/runtime parity

- Studio preview and Runtime share rendering primitives.
- Layout serialization is deterministic.
- Form behavior is independent of screen-specific hard-coded application logic.
- Keyboard navigation and focus states are first-class.

## Acceptance criteria

- Serialized layout fixtures render consistently across supported desktop platforms.
- Generated CRUD forms can be reopened and edited as ordinary forms.
- Master/detail works for one relationship level.
- Conditional visibility/enabled state reacts deterministically to expression changes.
- Hidden/unauthorized navigation items cannot be invoked through direct runtime object entry.

## Non-goals

- absolute pixel canvas for forms;
- arbitrary nested subforms;
- custom scripted controls;
- browser/mobile renderer in MVP.
