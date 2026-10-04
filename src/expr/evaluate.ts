import { type Ast, type AstOf, errorAt } from "./ast";
import { arityMessage, type Call, lookupFunction } from "./functions";
import {
  compareValues,
  fromHost,
  isRecord,
  normalizeNumber,
  toText,
  typeName,
  type Value,
} from "./values";

interface Env {
  lookup(name: string): { value: Value } | undefined;
  now(): Date;
}

export function makeEnv(scope: Record<string, unknown>, now?: Date): Env {
  return {
    lookup: (name) =>
      isRecord(scope) && Object.hasOwn(scope, name) ? { value: fromHost(scope[name]) } : undefined,
    now: () => now ?? new Date(),
  };
}

function itemEnv(parent: Env, item: unknown): Env {
  const row = fromHost(item);
  return {
    lookup: (name) => {
      if (name === "item") return { value: row };
      if (isRecord(row) && Object.hasOwn(row, name)) return { value: fromHost(row[name]) };
      return parent.lookup(name);
    },
    now: parent.now,
  };
}

function readField(node: Ast, target: Value, field: string): Value {
  if (target === null) return null;
  if (Array.isArray(target)) return target.map((item) => readField(node, fromHost(item), field));
  if (isRecord(target)) return Object.hasOwn(target, field) ? fromHost(target[field]) : null;
  throw errorAt(node, `Can't read '${field}' from ${typeName(target)}`);
}

function evalName(node: AstOf<"name">, env: Env): Value {
  const [root, ...rest] = node.path;
  const found = env.lookup(root);
  if (!found) throw errorAt(node, `Unknown name '${root}'`);
  let value = found.value;
  for (const field of rest) value = readField(node, value, field);
  return value;
}

function bool(node: Ast, v: Value, what: string): boolean | null {
  if (v === null || typeof v === "boolean") return v;
  throw errorAt(node, `${what} needs true or false but got ${typeName(v)}`);
}

function scalar(node: Ast, v: Value): Value {
  if (v !== null && typeof v === "object") throw errorAt(node, `Can't compare a ${typeName(v)}`);
  return v;
}

const ARITHMETIC_VERB: Record<string, string> = {
  "+": "add",
  "-": "subtract",
  "*": "multiply",
  "/": "divide",
  "%": "take the remainder of",
};

function evalBinary(node: AstOf<"binary">, env: Env): Value {
  const { op } = node;
  if (op === "and" || op === "or") {
    const left = bool(node.left, evalNode(node.left, env), `'${op}'`);
    if (op === "and" && left === false) return false;
    if (op === "or" && left === true) return true;
    const right = bool(node.right, evalNode(node.right, env), `'${op}'`);
    if (op === "and")
      return right === false ? false : left === null || right === null ? null : true;
    return right === true ? true : left === null || right === null ? null : false;
  }
  const left = evalNode(node.left, env);
  const right = evalNode(node.right, env);
  if (op === "&") {
    for (const [side, v] of [
      [node.left, left],
      [node.right, right],
    ] as const) {
      if (v !== null && typeof v === "object")
        throw errorAt(side, `Can't join ${typeName(v)} as text`);
    }
    return toText(left) + toText(right);
  }
  if (op in ARITHMETIC_VERB) {
    if (left === null || right === null) return null;
    if (typeof left !== "number" || typeof right !== "number") {
      const hint =
        op === "+" && (typeof left === "string" || typeof right === "string")
          ? "; use & to join text"
          : "";
      throw errorAt(
        node,
        `Can't ${ARITHMETIC_VERB[op]} ${typeName(left)} and ${typeName(right)}${hint}`,
      );
    }
    if ((op === "/" || op === "%") && right === 0) return null;
    const result = normalizeNumber(
      op === "+"
        ? left + right
        : op === "-"
          ? left - right
          : op === "*"
            ? left * right
            : op === "/"
              ? left / right
              : left % right,
    );
    if (!Number.isFinite(result)) throw errorAt(node, "Number is too large");
    return result;
  }
  const a = scalar(node.left, left);
  const b = scalar(node.right, right);
  if (a === null || b === null) return null;
  const cmp = compareValues(a, b);
  if (op === "=") return cmp === 0;
  if (op === "!=") return cmp !== 0;
  if (cmp === undefined) throw errorAt(node, `Can't compare ${typeName(a)} with ${typeName(b)}`);
  switch (op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    default:
      return cmp >= 0;
  }
}

function evalIn(node: AstOf<"in">, env: Env): Value {
  const v = scalar(node.operand, evalNode(node.operand, env));
  if (v === null) return null;
  let sawNull = false;
  for (const itemNode of node.list) {
    const raw = evalNode(itemNode, env);
    const items = Array.isArray(raw) ? raw.map(fromHost) : [raw];
    for (const item of items) {
      if (item === null) sawNull = true;
      else if (compareValues(v, scalar(itemNode, item)) === 0) return !node.negated;
    }
  }
  return sawNull ? null : node.negated;
}

function evalBetween(node: AstOf<"between">, env: Env): Value {
  const v = scalar(node.operand, evalNode(node.operand, env));
  const low = scalar(node.low, evalNode(node.low, env));
  const high = scalar(node.high, evalNode(node.high, env));
  if (v === null || low === null || high === null) return null;
  const c1 = compareValues(v, low);
  const c2 = compareValues(v, high);
  if (c1 === undefined || c2 === undefined) {
    throw errorAt(
      node,
      `Can't compare ${typeName(v)} with ${typeName(c1 === undefined ? low : high)}`,
    );
  }
  return c1 >= 0 && c2 <= 0 ? !node.negated : node.negated;
}

function evalCall(node: AstOf<"call">, env: Env): Value {
  const def = lookupFunction(node.name);
  if (!def)
    throw errorAt({ start: node.start, end: node.nameEnd }, `Unknown function '${node.name}'`);
  const arity = arityMessage(node.name, def, node.args.length);
  if (arity) throw errorAt(node, arity);
  const call: Call = {
    node,
    count: node.args.length,
    arg: (i) => evalNode(node.args[i], env),
    argForItem: (i, item) => evalNode(node.args[i], itemEnv(env, item)),
    now: env.now,
  };
  return def.impl(call);
}

export function evalNode(node: Ast, env: Env): Value {
  switch (node.type) {
    case "literal":
    case "date":
      return node.value;
    case "name":
      return evalName(node, env);
    case "unary": {
      const v = evalNode(node.operand, env);
      if (node.op === "not") {
        const b = bool(node.operand, v, "'not'");
        return b === null ? null : !b;
      }
      if (v === null) return null;
      if (typeof v !== "number") throw errorAt(node, `Can't negate ${typeName(v)}`);
      return v === 0 ? 0 : -v;
    }
    case "binary":
      return evalBinary(node, env);
    case "in":
      return evalIn(node, env);
    case "between":
      return evalBetween(node, env);
    case "isnull": {
      const isNull = evalNode(node.operand, env) === null;
      return node.negated ? !isNull : isNull;
    }
    case "call":
      return evalCall(node, env);
  }
}
