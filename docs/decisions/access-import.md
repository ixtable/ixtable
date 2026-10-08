# Access import

Status: accepted. Covers one-way import of Microsoft Access databases and
templates into a new document. PRD §1 and §31 keep every other kind of Access
interoperability out of scope. The file formats are specified in
[`docs/access-format.md`](../access-format.md).

## Context

Access users are ixtable's first audience, and their applications live in
`.accdb` and `.mdb` files or start from Microsoft's featured templates
(`.accdt`). Rebuilding an application by hand loses data and weeks of work.
The import has to:

- Run on Windows, macOS, and Linux with no Access, ODBC driver, or Java
  installed.
- Keep tables, rows, keys, relationships, and validation, and never drop rows
  silently.
- Carry over as much behavior as ixtable can express: queries, forms, reports,
  and macros.
- Say plainly what did not convert and why.

Microsoft documents none of the formats. Binary files store forms, reports,
and VBA compiled, in an undocumented layout. Templates store the same objects
as SaveAsText, a readable text format.

## Decision

**Readers.** Two pure-Rust readers in `src-tauri/src/access/` build one model
(`model.rs`, trait `AccessFile`). `accdt.rs` reads template packages, with
`text_format.rs` for SaveAsText and `xml.rs` for the XML parts. `jet/` reads
Jet 3, Jet 4, and ACE page files: header and RC4 masking (`page.rs`), table
definitions (`tdef.rs`), rows and value types (`row.rs`, `text.rs`), property
maps (`props.rs`), and the system catalog with relationships, queries, and
complex columns (`catalog.rs`). The readers do not decode compiled forms,
reports, macros, or VBA in binary files. They list them so the wizard can say
so. Password-protected ACE files are refused with a message to remove the
password. Jet 3 and Jet 4 page encryption is decrypted.

**Conversion.** `convert::convert` turns the model into a `DocumentConfig` and a
staged copy of the data, in this order:

1. `schema::plan_tables` maps each table to SQLite. Types follow
   `schema::declared_type`. Attachment and multi-value fields become child
   tables. Enforced relationships become foreign keys
   (`plan_relationships`). Calculated columns become plain columns kept
   current by triggers (`calc_triggers_sql`).
2. `staging` loads every row into a scratch SQLite file and checks each
   planned constraint against the data. Access lets old rows break a rule added
   later, so a constraint the data breaks is dropped and reported. Rows are
   never dropped.
3. `queries::convert` translates Access SQL to DuckDB SQL with
   `translate::sql`. Queries that depend on other queries become CTEs. Prompt
   parameters become saved-query parameters. Action queries (append, update,
   delete, make-table) have no saved-query equivalent, so their Access SQL is
   kept in `settings.accessImport.actionQueries` and reported.
4. Reports (`reports.rs`), macros (`macros.rs`), then forms (`forms.rs`,
   `controls.rs`) convert, in that order so buttons only point at objects that
   exist. Expressions go through `translate::expr` into the ixtable expression
   language. Layout goes from twips to grid cells (`layout.rs`). Subforms
   become related lists, with one level of nesting
   (`forms::unnest_related_lists`). Datasheet and continuous forms become list
   forms. Window, focus, and error-handling macro actions are dropped because
   ixtable has no such state. Every other loss is a note on the object.
5. Binary files, and tables no readable form covers, get a generated list
   form and detail form per table (`autoforms.rs`). `navigation.rs` builds the
   navigation from Access navigation forms, `AutoExec`, and `StartUpForm`.

`convert::create` then opens a new untitled document, as `templates::create`
does. It stores the definitions, applies the schema as
migration 001, copies the staged rows in with foreign keys checked, and checks
each saved query with `DESCRIBE`. VBA modules and code-behind are kept as the
text asset `Access VBA.txt`. The conversion report, with a status and notes
for every object, is stored in `settings.accessImport.report` and returned to
the wizard.

**Commands and UI.** `inspect_access_file` returns an inventory (tables, row
counts, objects, compiled objects, warnings) without changing anything.
`import_access_file` runs the conversion. Both run on a blocking thread. The
wizard is `src/access/AccessImportWizard.tsx`, opened from the start screen's
"Import Access database…" button: choose a file, review the inventory, choose
whether to import data, import, read the report, open the document.

## Consequences

- Importing a binary database keeps its data, keys, relationships, and
  queries, but not its forms and reports. The workaround is to save the
  database as a template in Access first and import the `.accdt`.
- VBA does not run. Applications that rely on it import with their data and
  layout, and the report names each button and event that lost its code.
- Access SQL is translated, not emulated. A call to a VBA function defined in a
  module yields an empty column, with a note. A built-in function with no
  DuckDB equivalent makes the query fail translation, and the report names
  it.
- Text comparison in translated queries is case-insensitive, as in Access,
  through `lower()`. This costs index use in large tables.
- An Access rule the data already breaks is not enforced after import. The
  report lists it so the developer can clean the data and add it back.
- One level of master and detail: a form opened from a related list cannot
  hold related lists itself, so such rows open nothing.

## Evidence

- `src-tauri/src/access/tests/`: SaveAsText parsing (`text_format.rs`), template
  reading and the fixture package in `tests/fixtures/access/template/`
  (`accdt.rs`), page-file decoding of `orders.accdb`, `orders.mdb`, and the
  Jackcess `complex-data.accdb` (`jet.rs`), SQL and expression translation
  (`translate.rs`), and full conversions into working documents
  (`convert.rs`).
- `tests/unit/access-summary.test.ts` and
  `tests/integration/access-import.test.tsx`: the wizard against the real
  command through the test bridge.
- Optional corpus tests: `node scripts/access/fetch-templates.mjs <dir>` downloads
  the 30 featured templates, and `IXTABLE_ACCESS_TEMPLATES_DIR=<dir> cargo test
  --lib access::` imports each one and fails on any config validation error.
  The same variable pointed at a folder of `.accdb` and `.mdb` files runs
  them as well. `IXTABLE_ACCESS_ONLY=<name>` limits the run to one file and
  `IXTABLE_ACCESS_VERBOSE=1` prints every note. On 2026-10-08 all 30
  templates and 111 binary files (the Jackcess and mdbtools test databases
  plus the templates saved as `.accdb`) imported with no validation errors:
  776 objects converted, 598 partly converted, 62 not converted.
- `IXTABLE_ACCESS_COMPARE_IN` and `IXTABLE_ACCESS_COMPARE_OUT` dump every table
  of a folder of binary files in a normalized text form, for comparison with
  another reader such as Jackcess.

## Audit log

- 2026-10-08: record created with the importer.
