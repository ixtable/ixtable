# Expressions

ixtable uses one small expression language for validation rules, computed
values, show/hide and enable/disable conditions, filters, formatting, action
conditions, and report totals. It looks like an Excel or Access formula. It
can't run JavaScript, call host code, or reach anything outside the values the
app passes in.

```text
record.amount * (1 + record.taxRate)
if(isblank(record.email), 'No email', lower(record.email))
record.status in ('open', 'pending') and record.due < today()
sumof(rows, qty * price)
format(record.total, '$#,##0.00')
```

## Values

| Kind | Examples |
|---|---|
| Number | `42`, `3.25`, `.5`, `1e3` |
| Text | `'single'`, `"double"`. Write a quote twice to include it: `'it''s'` |
| Boolean | `true`, `false` |
| Null | `null` (no value) |
| Date | `#2026-01-31#`, `#2026-01-31T09:30:00#` |

Dates are plain text in ISO form: `YYYY-MM-DD` for a date and
`YYYY-MM-DDTHH:MM:SS` for a date and time. All date work happens in UTC, so a
result never depends on the computer's time zone.

## Names

The app provides root names such as `record`, `form`, `params`, `app`, or
`rows`. Use dots to read fields: `record.amount`, `app.user.email`. Put names
with spaces or symbols in square brackets: `record.[Unit Price]`,
`[Total Due]`.

- An unknown root name is an error. A missing field below a root is null.
- Reading a field from a list reads it from every item: `rows.amount` is the
  list of all amounts.
- Only the data itself is visible. Names like `constructor`, `__proto__`, and
  `prototype` are rejected, and inherited or function-valued properties read
  as null.
- Keywords and function names ignore case (`AND`, `If`). Field names don't.

## Operators

From loosest to tightest binding:

| Operators | Meaning |
|---|---|
| `or`, `\|\|` | either is true |
| `and`, `&&` | both are true |
| `not`, `!` | negation |
| `=` `==` `!=` `<>` `<` `<=` `>` `>=` | comparison |
| `x in (a, b)`, `x not in (…)` | membership; a list value inside the parentheses is expanded |
| `x between a and b`, `x not between …` | inclusive range |
| `x is null`, `x is not null` | null test |
| `&` | join as text |
| `+` `-` | add, subtract |
| `*` `/` `%` | multiply, divide, remainder |
| `-x` | negative |

Comparisons can't be chained: write `a < b and b < c`, not `a < b < c`.

- Arithmetic needs numbers. `'a' + 1` is an error. Use `&` to join text.
- Text comparison is case-sensitive and by character code. Use `lower()` to
  compare without case.
- Two values that are both dates compare as dates, so `#2026-01-31#` equals
  `'2026-01-31T00:00:00'`.
- `=` and `!=` between different kinds (a number and text) give false and
  true. Ordering different kinds (`1 < 'a'`) is an error.

## Null rules

Null follows SQL rules:

- Arithmetic with null gives null: `null + 1` is null.
- Comparisons with null give null, including `null = null`. Test for null
  with `is null` or `isnull()`.
- `not null` is null.
- `and`: false wins, then null. `null and false` is false, `null and true` is
  null.
- `or`: true wins, then null. `null or true` is true, `null or false` is null.
- `x in (…)` is null when `x` is null, or when nothing matches and the list
  holds a null.
- `&` and `concat()` treat null as empty text: `'a' & null` is `'a'`.
- Most functions return null when a required argument is null.
- Where a true/false answer is needed (show, enable, validate, filter, action
  conditions), null counts as false.

## Numbers

Results of `+ - * / %` are rounded to 15 significant digits, so binary
floating point noise never appears: `0.1 + 0.2` is `0.3`. `round()` rounds
half away from zero and works on the decimal value you see, so
`round(1.005, 2)` is `1.01`.

Dividing by zero, or `% 0`, gives null. It is not an error. `%` keeps the
sign of the left operand, as in SQL.

## Functions

| Function | Result |
|---|---|
| `if(cond, a, b)`, `iif` | `a` when `cond` is true, else `b` (null when `b` is left out). Only the chosen branch runs |
| `coalesce(a, b, …)`, `nz` | first value that isn't null |
| `isnull(x)` | true when `x` is null |
| `isblank(x)` | true when `x` is null or only whitespace |
| `len(t)` | number of characters |
| `lower(t)`, `upper(t)`, `trim(t)` | changed text |
| `left(t, n)`, `right(t, n)` | first or last `n` characters (`n` defaults to 1) |
| `mid(t, start, len)`, `substr` | `len` characters from position `start` (1 is the first). Without `len`, the rest |
| `concat(a, b, …)` | joined text, skipping nulls |
| `contains(t, s)`, `startswith(t, s)`, `endswith(t, s)` | text search, ignoring case |
| `replace(t, find, with)` | every `find` replaced with `with` |
| `regexmatch(t, pattern)` | true when the regular expression matches |
| `round(n, digits)`, `floor(n, digits)`, `ceil(n, digits)` | rounded number (`digits` defaults to 0 and may be negative) |
| `abs(n)` | absolute value |
| `min(…)`, `max(…)` | smallest or largest value; lists are expanded and nulls skipped. Works on numbers, text, and dates |
| `sum(…)`, `avg(…)`, `count(…)` | total, average, and number of non-null values; lists are expanded. `sum` of nothing is 0, `avg` of nothing is null |
| `sumof(list, expr)`, `avgof`, `minof`, `maxof` | `expr` worked out for each item, then combined |
| `countof(list, cond)` | number of items where `cond` is true |
| `today()`, `now()` | current UTC date, or date and time |
| `date(y, m, d)` | a date; out-of-range months and days roll over (`date(2026, 13, 1)` is 2027-01-01) |
| `year(d)`, `month(d)`, `day(d)`, `hour(d)`, `minute(d)`, `weekday(d)` | part of a date; `weekday` is 1 for Sunday to 7 for Saturday |
| `datediff(unit, a, b)` | how many unit boundaries lie between `a` and `b`; negative when `b` is earlier |
| `dateadd(unit, n, d)` | `d` moved by `n` units; adding months keeps the day or uses the month's last day |
| `format(x, pattern)` | number or date as text using a pattern (below) |
| `text(x)`, `text(x, pattern)` | value as text |
| `number(x)` | number from text (commas allowed), `true` as 1, `false` as 0; null if the text isn't a number |

Units for `datediff` and `dateadd`: `year` (`y`), `month` (`m`), `week` (`w`),
`day` (`d`), `hour` (`h`), `minute` (`n`, `mi`), `second` (`s`). Plurals work
too. `datediff` counts boundaries like Access: from Jan 31 to Feb 1 is one
month.

Inside the second argument of `sumof`, `avgof`, `minof`, `maxof` and
`countof`, each item's fields can be used by name, and `item` is the whole
item: `sumof(rows, qty * price)`, `countof(rows, item.paid)`. Other names
still come from the app.

### Regular expressions

`regexmatch` uses JavaScript regular expression syntax. Patterns longer than
200 characters, back-references (`\1`), and repeated groups that already
repeat inside (`(a+)+`, `(\d*)*`) are rejected, because they can take
minutes to run on some inputs. Text longer than 10,000 characters is an error.

## Format patterns

Numbers:

| Pattern | 1234.5 | Notes |
|---|---|---|
| `0` | `1235` | `0` always shows a digit |
| `0.00` | `1234.50` | |
| `#,##0` | `1,235` | a comma turns on thousands separators |
| `#,##0.##` | `1,234.5` | `#` shows a digit only when needed |
| `$#,##0.00` | `$1,234.50` | text before or after the digits is kept |
| `0%` | `123450%` | `%` multiplies by 100 |

Negative numbers get a leading `-`: `-$1,234.50`.

Dates:

| Token | Meaning | Token | Meaning |
|---|---|---|---|
| `yyyy` | 2026 | `yy` | 26 |
| `MMMM` | January | `MMM` | Jan |
| `MM` | 01 | `M` | 1 |
| `dddd` | Monday | `ddd` | Mon |
| `dd` | 05 | `d` | 5 |
| `HH` | 15 (24-hour) | `hh`, `h` | 03, 3 (12-hour) |
| `mm`, `m` | minutes | `ss`, `s` | seconds |
| `tt` | AM or PM | `'text'` | literal text |

For example, `format(#2026-01-05#, 'MMM d, yyyy')` is `Jan 5, 2026`.

## Errors

Syntax errors, unknown functions, wrong argument counts, and type errors (such
as `'a' * 2`) stop the expression with a message and the position of the
problem. The editor checks expressions as you type and flags unknown names.

## For developers

`src/expr/index.ts` exports `parse`, `evaluate`, `evaluateBoolean`, `check`,
`referencedNames`, `formatValue`, and `ExprError` (`message`, `start`,
`end`). Pass the clock as `evaluate(src, scope, { now })` to make `today()`
and `now()` deterministic in tests. Parsed expressions are cached (up to 500).
