---
sidebar_position: 1
---

# Expressions

_Reference for the ixtable expression language: values, names, operators, null rules, functions, and the names each kind of expression can read._

ixtable uses one formula language for validation rules, computed fields, defaults, show and enable conditions, filters, conditional styles, action steps, trigger conditions, report totals, and dashboard numbers. It reads like a spreadsheet or Access formula. An expression can only read the values the app passes in. It cannot run code, call the network, or query the database.

```text
record.amount * (1 + record.taxRate)
if(isblank(record.email), 'No email', lower(record.email))
record.status in ('open', 'pending') and record.due < today()
sumof(rows, qty * price)
format(record.total, '$#,##0.00')
```

Every editor that takes an expression checks it as you type and flags unknown names and syntax errors next to the field. The same evaluator runs in the designer, the Runtime, reports, dashboards, and automation, so a formula gives the same answer everywhere.

## Values

| Kind | Examples |
| --- | --- |
| Number | `42`, `3.25`, `.5`, `1e3` |
| Text | `'single'`, `"double"`. Write a quote twice to include it: `'it''s'` |
| Boolean | `true`, `false` |
| Null | `null`, meaning no value |
| Date | `#2026-01-31#`, `#2026-01-31T09:30:00#` |

Dates are text in ISO form: `YYYY-MM-DD` for a date and `YYYY-MM-DDTHH:MM:SS` for a date and time. All date math runs in UTC, so a result never depends on the computer's time zone.

## Names

Each kind of expression gets a few root names, such as `record`, `form`, `app`, `params`, or `rows`. Read fields with dots: `record.amount`, `app.user.email`. Put names that contain spaces or symbols in square brackets: `record.[Unit Price]`.

An unknown root name is an error. A missing field below a known root reads as null. Reading a field from a list reads it from every item, so `rows.amount` is the list of all amounts. Keywords and function names ignore case, so `AND` and `If` work. Field names are case-sensitive.

## Where expressions run

| Expression | Names it can read |
| --- | --- |
| Form validation, show, enable, computed value, default | `record`, `form`, `app`, `value` |
| Form conditional style | `record`, `form`, `app`, `value` (the control's value) |
| List form filter | `record` (the row), `app`, `params`, `form` |
| Related list filter | `record` (the child row), `parent` (the record on screen), `form`, `app` |
| Lookup choice filter | `record` (the choice row), `parent` (the record being edited), `form`, `app` |
| Action step | `record`, `old`, `form`, `app`, `params`, `results` |
| Trigger condition | `record`, `old` (on updates), `app` |
| Dashboard number | `rows`, `params`, `app` |
| Dashboard show and enable | `params`, `app` |
| Dashboard table filter | `record` (the row), `params`, `app` |
| Dashboard table style | `record`, `value` (the cell), `params`, `app` |

A filter keeps a row only when it gives true. Null, false, and an error all drop the row. Where a rule needs a yes or no answer, such as show, enable, validate, or an action's **Only when**, null counts as false. Conditional styles apply the first rule whose condition is true.

Show and enable conditions change what a person sees. They are not access control. Use [roles](../guides/roles) to stop someone from reading or changing data.

## Operators

From loosest to tightest binding:

| Operators | Meaning |
| --- | --- |
| `or`, `\|\|` | either is true |
| `and`, `&&` | both are true |
| `not`, `!` | negation |
| `=` `==` `!=` `<>` `<` `<=` `>` `>=` | comparison |
| `x in (a, b)`, `x not in (...)` | membership. A list inside the parentheses is expanded |
| `x between a and b`, `x not between ...` | inclusive range |
| `x is null`, `x is not null` | null test |
| `&` | join as text |
| `+` `-` | add, subtract |
| `*` `/` `%` | multiply, divide, remainder |
| `-x` | negative |

Comparisons do not chain. Write `a < b and b < c`, not `a < b < c`.

Arithmetic needs numbers, so `'a' + 1` is an error. Join text with `&`. Text comparison is case-sensitive and compares character codes, with no locale. Use `lower()` to compare without case. Two dates compare as dates, so `#2026-01-31#` equals `'2026-01-31T00:00:00'`. Equality between different kinds, such as a number and text, is false. Ordering different kinds, such as `1 < 'a'`, is an error.

## Null rules

Null follows SQL rules.

- Arithmetic with null gives null: `null + 1` is null.
- Comparisons with null give null, including `null = null`. Test with `is null` or `isnull()`.
- `not null` is null.
- In `and`, false wins, then null. `null and false` is false, and `null and true` is null.
- In `or`, true wins, then null. `null or true` is true, and `null or false` is null.
- `&` and `concat()` treat null as empty text, so `'a' & null` is `'a'`.
- Most functions return null when a required argument is null.

## Numbers

Results of `+ - * / %` round to 15 significant digits, so floating point noise never shows: `0.1 + 0.2` is `0.3`. `round()` rounds half away from zero on the decimal value you see, so `round(1.005, 2)` is `1.01`. Dividing by zero, or `% 0`, gives null. `%` keeps the sign of the left operand, as in SQL.

## Functions

| Function | Result |
| --- | --- |
| `if(cond, a, b)`, `iif` | `a` when `cond` is true, else `b`. Null when `b` is left out. Only the chosen branch runs |
| `coalesce(a, b, ...)`, `nz` | the first value that is not null |
| `isnull(x)` | true when `x` is null |
| `isblank(x)` | true when `x` is null or only whitespace |
| `len(t)` | number of characters |
| `lower(t)`, `upper(t)`, `trim(t)` | changed text |
| `left(t, n)`, `right(t, n)` | first or last `n` characters. `n` defaults to 1 |
| `mid(t, start, len)`, `substr` | `len` characters from position `start`, where 1 is the first. Without `len`, the rest |
| `concat(a, b, ...)` | joined text, skipping nulls |
| `contains(t, s)`, `startswith(t, s)`, `endswith(t, s)` | text search that ignores case |
| `replace(t, find, with)` | every `find` replaced with `with` |
| `regexmatch(t, pattern)` | true when the regular expression matches |
| `round(n, digits)`, `floor(n, digits)`, `ceil(n, digits)` | rounded number. `digits` defaults to 0 and may be negative |
| `abs(n)` | absolute value |
| `min(...)`, `max(...)` | smallest or largest value of numbers, text, or dates. Lists are expanded and nulls skipped |
| `sum(...)`, `avg(...)`, `count(...)` | total, average, and count of non-null values. `sum` of nothing is 0 and `avg` of nothing is null |
| `sumof(list, expr)`, `avgof`, `minof`, `maxof` | `expr` worked out for each item, then combined |
| `countof(list, cond)` | number of items where `cond` is true |
| `today()`, `now()` | the current UTC date, or date and time |
| `date(y, m, d)` | a date. Out-of-range months and days roll over, so `date(2026, 13, 1)` is 2027-01-01 |
| `year(d)`, `month(d)`, `day(d)`, `hour(d)`, `minute(d)`, `weekday(d)` | part of a date. `weekday` is 1 for Sunday to 7 for Saturday |
| `datediff(unit, a, b)` | how many unit boundaries lie between `a` and `b`. Negative when `b` is earlier |
| `dateadd(unit, n, d)` | `d` moved by `n` units. Adding months keeps the day or uses the month's last day |
| `format(x, pattern)` | a number or date as text, using a pattern |
| `text(x)`, `text(x, pattern)` | a value as text |
| `number(x)` | a number from text, with commas allowed. `true` is 1 and `false` is 0. Null when the text is not a number |

Units for `datediff` and `dateadd` are `year` (`y`), `month` (`m`), `week` (`w`), `day` (`d`), `hour` (`h`), `minute` (`n`, `mi`), and `second` (`s`). Plurals work too. `datediff` counts boundaries the way Access does, so January 31 to February 1 is one month.

Inside the second argument of `sumof`, `avgof`, `minof`, `maxof`, and `countof`, each item's fields are available by name, and `item` is the whole item. For example, `sumof(rows, qty * price)` totals a line amount and `countof(rows, item.paid)` counts paid rows.

`regexmatch` uses JavaScript regular expression syntax. It rejects patterns longer than 200 characters, back-references such as `\1`, and nested repeats such as `(a+)+`, because those can run for minutes. Text longer than 10,000 characters is an error.

## Format patterns

Number patterns, shown for the value `1234.5`:

| Pattern | Result | Notes |
| --- | --- | --- |
| `0` | `1235` | `0` always shows a digit |
| `0.00` | `1234.50` | |
| `#,##0` | `1,235` | a comma turns on thousands separators |
| `#,##0.##` | `1,234.5` | `#` shows a digit only when needed |
| `$#,##0.00` | `$1,234.50` | text before or after the digits is kept |
| `0%` | `123450%` | `%` multiplies by 100 |

Negative numbers get a leading `-`, as in `-$1,234.50`.

Date tokens:

| Token | Meaning | Token | Meaning |
| --- | --- | --- | --- |
| `yyyy` | 2026 | `yy` | 26 |
| `MMMM` | January | `MMM` | Jan |
| `MM` | 01 | `M` | 1 |
| `dddd` | Monday | `ddd` | Mon |
| `dd` | 05 | `d` | 5 |
| `HH` | 15, 24-hour | `hh`, `h` | 03, 3, 12-hour |
| `mm`, `m` | minutes | `ss`, `s` | seconds |
| `tt` | AM or PM | `'text'` | literal text |

For example, `format(#2026-01-05#, 'MMM d, yyyy')` gives `Jan 5, 2026`.

## Errors

A syntax error, an unknown function, a wrong number of arguments, or a type error such as `'a' * 2` stops the expression with a message and the position of the problem. Editors show these errors under the field while you type. In the Runtime, a filter that fails drops the row, and a condition that fails counts as false.

## Next steps

- [Design view](../concepts/design-view)
- [Automation](../guides/automation)
- [Reports](../guides/reports)
- [Dashboards](../guides/dashboards)
