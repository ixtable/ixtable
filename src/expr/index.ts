import { type Ast, type Diagnostic, ExprError } from "./ast";
import { evalNode, makeEnv } from "./evaluate";
import { formatValue } from "./format";
import {
  arityMessage,
  compileSafeRegex,
  functionNames,
  lookupFunction,
  parseUnit,
} from "./functions";
import { parseSource } from "./parser";
import { typeName } from "./values";

export type { Ast, Diagnostic };
export { ExprError, formatValue, functionNames };

export interface EvaluateOptions {
  /** Clock used by `today()` and `now()`. Defaults to the current time. */
  now?: Date;
}

const CACHE_LIMIT = 500;
const cache = new Map<string, Ast>();

/** Parses an expression. Throws `ExprError` with the offending character range. */
export function parse(src: string): Ast {
  const hit = cache.get(src);
  if (hit) {
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  const ast = parseSource(src);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(src, ast);
  return ast;
}

/**
 * Evaluates an expression against `scope`. Root names (`record`, `form`,
 * `params`, …) are looked up as own properties of `scope`; nothing on the
 * prototype chain is reachable. Throws `ExprError` on syntax and type errors.
 */
export function evaluate(
  srcOrAst: string | Ast,
  scope: Record<string, unknown> = {},
  options: EvaluateOptions = {},
): unknown {
  const ast = typeof srcOrAst === "string" ? parse(srcOrAst) : srcOrAst;
  return evalNode(ast, makeEnv(scope, options.now));
}

/** Evaluates a condition. Null counts as false; any non-boolean result throws. */
export function evaluateBoolean(
  srcOrAst: string | Ast,
  scope: Record<string, unknown> = {},
  options: EvaluateOptions = {},
): boolean {
  const ast = typeof srcOrAst === "string" ? parse(srcOrAst) : srcOrAst;
  const value = evalNode(ast, makeEnv(scope, options.now));
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  throw new ExprError(`Expected true or false but got ${typeName(value)}`, ast.start, ast.end);
}

function walk(node: Ast, visit: (node: Ast, inItem: boolean) => void, inItem = false): void {
  visit(node, inItem);
  switch (node.type) {
    case "unary":
      walk(node.operand, visit, inItem);
      break;
    case "binary":
      walk(node.left, visit, inItem);
      walk(node.right, visit, inItem);
      break;
    case "in":
      walk(node.operand, visit, inItem);
      for (const item of node.list) walk(item, visit, inItem);
      break;
    case "between":
      walk(node.operand, visit, inItem);
      walk(node.low, visit, inItem);
      walk(node.high, visit, inItem);
      break;
    case "isnull":
      walk(node.operand, visit, inItem);
      break;
    case "call": {
      const perItem = lookupFunction(node.name)?.perItemArg;
      node.args.forEach((arg, i) => walk(arg, visit, inItem || i === perItem));
      break;
    }
    default:
      break;
  }
}

/**
 * Lists the names an expression reads, as dotted paths (`record.amount`),
 * in order of first use. Names inside the per-item argument of `sumof`,
 * `countof` and friends refer to item fields and are left out.
 */
export function referencedNames(src: string): string[] {
  const names = new Set<string>();
  walk(parse(src), (node, inItem) => {
    if (node.type === "name" && !inItem) names.add(node.path.join("."));
  });
  return [...names];
}

function literalText(node: Ast | undefined): string | undefined {
  return node?.type === "literal" && typeof node.value === "string" ? node.value : undefined;
}

/**
 * Reports problems without running the expression: syntax errors, unknown
 * functions, wrong argument counts, bad literal units and regex patterns, and
 * (when `knownNames` is given) names that aren't known. A known name covers
 * everything below it: `record` allows `record.anything`.
 */
export function check(src: string, knownNames?: string[]): Diagnostic[] {
  let ast: Ast;
  try {
    ast = parse(src);
  } catch (e) {
    if (e instanceof ExprError)
      return [{ severity: "error", message: e.message, start: e.start, end: e.end }];
    throw e;
  }
  const diagnostics: Diagnostic[] = [];
  const add = (node: { start: number; end: number }, message: string) =>
    diagnostics.push({ severity: "error", message, start: node.start, end: node.end });
  const known = knownNames && new Set(knownNames);
  let hasNames = false;
  walk(ast, (node, inItem) => {
    if (node.type === "name") {
      hasNames = true;
      if (!known || inItem) return;
      const prefixes = node.path.map((_, i) => node.path.slice(0, i + 1).join("."));
      if (prefixes.some((p) => known.has(p))) return;
      const rootKnown = knownNames.some((k) => k.split(".")[0] === node.path[0]);
      add(
        node,
        rootKnown ? `Unknown field '${node.path.join(".")}'` : `Unknown name '${node.path[0]}'`,
      );
      return;
    }
    if (node.type !== "call") return;
    const def = lookupFunction(node.name);
    if (!def) {
      add({ start: node.start, end: node.nameEnd }, `Unknown function '${node.name}'`);
      return;
    }
    const arity = arityMessage(node.name, def, node.args.length);
    if (arity) add(node, arity);
    if (node.name === "datediff" || node.name === "dateadd") {
      const unit = literalText(node.args[0]);
      if (unit !== undefined && !parseUnit(unit)) add(node.args[0], `Unknown date unit '${unit}'`);
    }
    if (node.name === "regexmatch") {
      const pattern = literalText(node.args[1]);
      try {
        if (pattern !== undefined) compileSafeRegex(pattern);
      } catch (e) {
        add(node.args[1], `regexmatch: ${(e as Error).message}`);
      }
    }
  });
  if (!diagnostics.length && !hasNames) {
    try {
      evalNode(ast, makeEnv({}));
    } catch (e) {
      if (e instanceof ExprError) add(e, e.message);
      else throw e;
    }
  }
  return diagnostics;
}
