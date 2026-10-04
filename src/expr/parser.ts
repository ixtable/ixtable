import { type Ast, type BinaryOp, ExprError } from "./ast";
import { parseIsoDate } from "./values";

type TokenKind = "num" | "str" | "date" | "ident" | "bracket" | "kw" | "op" | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  value?: number | string;
  start: number;
  end: number;
}

const KEYWORDS = new Set(["and", "or", "not", "in", "between", "is", "null", "true", "false"]);
const OPERATORS = [
  "&&",
  "||",
  "<=",
  ">=",
  "<>",
  "!=",
  "==",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "!",
  "(",
  ")",
  ",",
  ".",
];
const BLOCKED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SOURCE_LENGTH = 10_000;
const MAX_DEPTH = 100;

const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;
const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = NUMBER.exec(src.slice(i));
      const text = m ? m[0] : ch;
      i += text.length;
      if (IDENT_PART.test(src[i] ?? "")) {
        throw new ExprError(`Invalid number '${text}${src[i]}'`, start, i + 1);
      }
      tokens.push({ kind: "num", text, value: Number(text), start, end: i });
      continue;
    }
    if (ch === "'" || ch === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError("Unterminated string", start, src.length);
        if (src[i] === ch) {
          if (src[i + 1] === ch) {
            value += ch;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += src[i++];
      }
      tokens.push({ kind: "str", text: src.slice(start, i), value, start, end: i });
      continue;
    }
    if (ch === "#") {
      const close = src.indexOf("#", i + 1);
      if (close < 0) throw new ExprError("Unterminated date literal", start, src.length);
      const raw = src.slice(i + 1, close).trim();
      i = close + 1;
      const parsed = parseIsoDate(raw);
      if (!parsed) {
        throw new ExprError(
          `Invalid date '${raw}'; use #YYYY-MM-DD# or #YYYY-MM-DDTHH:MM:SS#`,
          start,
          i,
        );
      }
      tokens.push({ kind: "date", text: src.slice(start, i), value: parsed.iso, start, end: i });
      continue;
    }
    if (ch === "[") {
      const close = src.indexOf("]", i + 1);
      if (close < 0) throw new ExprError("Unterminated [name]", start, src.length);
      const name = src.slice(i + 1, close).trim();
      i = close + 1;
      if (!name) throw new ExprError("Empty [name]", start, i);
      tokens.push({ kind: "bracket", text: src.slice(start, i), value: name, start, end: i });
      continue;
    }
    if (IDENT_START.test(ch)) {
      while (i < src.length && IDENT_PART.test(src[i])) i++;
      const text = src.slice(start, i);
      const lower = text.toLowerCase();
      tokens.push({
        kind: KEYWORDS.has(lower) ? "kw" : "ident",
        text,
        value: KEYWORDS.has(lower) ? lower : text,
        start,
        end: i,
      });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected character '${ch}'`, start, start + 1);
    i += op.length;
    tokens.push({ kind: "op", text: op, start, end: i });
  }
  tokens.push({ kind: "eof", text: "", start: src.length, end: src.length });
  return tokens;
}

const COMPARISON: Record<string, BinaryOp> = {
  "=": "=",
  "==": "=",
  "!=": "!=",
  "<>": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parseRoot(): Ast {
    if (this.peek().kind === "eof") throw new ExprError("Expression is empty", 0, 0);
    const node = this.parseOr();
    const next = this.peek();
    if (next.kind !== "eof") throw this.unexpected(next);
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "op" && t.text === text;
  }

  private isKw(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "kw" && t.value === word;
  }

  private expectOp(text: string): Token {
    if (!this.isOp(text)) {
      const t = this.peek();
      throw new ExprError(
        t.kind === "eof" ? `Expected '${text}' but the expression ended` : `Expected '${text}'`,
        t.start,
        t.end,
      );
    }
    return this.next();
  }

  private unexpected(t: Token): ExprError {
    if (t.kind === "eof") return new ExprError("Unexpected end of expression", t.start, t.end);
    return new ExprError(`Unexpected '${t.text}'`, t.start, t.end);
  }

  private enter(t: Token): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) throw new ExprError("Expression is nested too deeply", t.start);
  }

  private parseOr(): Ast {
    let left = this.parseAnd();
    while (this.isKw("or") || this.isOp("||")) {
      this.next();
      const right = this.parseAnd();
      left = { type: "binary", op: "or", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseAnd(): Ast {
    let left = this.parseNot();
    while (this.isKw("and") || this.isOp("&&")) {
      this.next();
      const right = this.parseNot();
      left = { type: "binary", op: "and", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseNot(): Ast {
    if (this.isKw("not") || this.isOp("!")) {
      const t = this.next();
      this.enter(t);
      const operand = this.parseNot();
      this.depth--;
      return { type: "unary", op: "not", operand, start: t.start, end: operand.end };
    }
    return this.parseComparison();
  }

  private parseComparison(): Ast {
    const left = this.parseConcat();
    const node = this.parseComparisonTail(left);
    if (node !== left && this.atComparison()) {
      const t = this.peek();
      throw new ExprError("Comparisons can't be chained; combine them with 'and'", t.start, t.end);
    }
    return node;
  }

  private atComparison(): boolean {
    const t = this.peek();
    if (t.kind === "op" && t.text in COMPARISON) return true;
    if (this.isKw("in") || this.isKw("between") || this.isKw("is")) return true;
    return this.isKw("not") && (this.isKw("in", 1) || this.isKw("between", 1));
  }

  private parseComparisonTail(left: Ast): Ast {
    const t = this.peek();
    if (t.kind === "op" && t.text in COMPARISON) {
      this.next();
      const right = this.parseConcat();
      return {
        type: "binary",
        op: COMPARISON[t.text],
        left,
        right,
        start: left.start,
        end: right.end,
      };
    }
    if (this.isKw("is")) {
      this.next();
      const negated = this.isKw("not");
      if (negated) this.next();
      const n = this.peek();
      if (!this.isKw("null")) {
        throw new ExprError("Expected 'null' after 'is'", n.start, n.end);
      }
      this.next();
      return { type: "isnull", operand: left, negated, start: left.start, end: n.end };
    }
    let negated = false;
    if (this.isKw("not") && (this.isKw("in", 1) || this.isKw("between", 1))) {
      this.next();
      negated = true;
    }
    if (this.isKw("in")) {
      this.next();
      this.expectOp("(");
      const list: Ast[] = [];
      if (!this.isOp(")")) {
        do list.push(this.parseOr());
        while (this.isOp(",") && this.next());
      }
      const close = this.expectOp(")");
      return { type: "in", operand: left, list, negated, start: left.start, end: close.end };
    }
    if (this.isKw("between")) {
      this.next();
      const low = this.parseConcat();
      if (!this.isKw("and")) {
        const n = this.peek();
        throw new ExprError("Expected 'and' in 'between … and …'", n.start, n.end);
      }
      this.next();
      const high = this.parseConcat();
      return {
        type: "between",
        operand: left,
        low,
        high,
        negated,
        start: left.start,
        end: high.end,
      };
    }
    return left;
  }

  private parseConcat(): Ast {
    let left = this.parseAdditive();
    while (this.isOp("&")) {
      this.next();
      const right = this.parseAdditive();
      left = { type: "binary", op: "&", left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseAdditive(): Ast {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().text as BinaryOp;
      const right = this.parseMultiplicative();
      left = { type: "binary", op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseMultiplicative(): Ast {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().text as BinaryOp;
      const right = this.parseUnary();
      left = { type: "binary", op, left, right, start: left.start, end: right.end };
    }
    return left;
  }

  private parseUnary(): Ast {
    if (this.isOp("-") || this.isOp("+")) {
      const t = this.next();
      this.enter(t);
      const operand = this.parseUnary();
      this.depth--;
      if (t.text === "+") return { ...operand, start: t.start };
      if (operand.type === "literal" && typeof operand.value === "number") {
        return { type: "literal", value: -operand.value || 0, start: t.start, end: operand.end };
      }
      return { type: "unary", op: "-", operand, start: t.start, end: operand.end };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Ast {
    const t = this.peek();
    switch (t.kind) {
      case "num":
      case "str":
        this.next();
        return { type: "literal", value: t.value ?? null, start: t.start, end: t.end };
      case "date":
        this.next();
        return { type: "date", value: String(t.value), start: t.start, end: t.end };
      case "kw":
        if (t.value === "null" || t.value === "true" || t.value === "false") {
          this.next();
          const value = t.value === "null" ? null : t.value === "true";
          return { type: "literal", value, start: t.start, end: t.end };
        }
        throw this.unexpected(t);
      case "ident":
        if (this.isOp("(", 1)) return this.parseCall();
        return this.parsePath();
      case "bracket":
        return this.parsePath();
      case "op":
        if (t.text === "(") {
          this.next();
          this.enter(t);
          const inner = this.parseOr();
          this.depth--;
          const close = this.expectOp(")");
          return { ...inner, start: t.start, end: close.end };
        }
        throw this.unexpected(t);
      default:
        throw this.unexpected(t);
    }
  }

  private parseCall(): Ast {
    const nameTok = this.next();
    this.enter(nameTok);
    this.expectOp("(");
    const args: Ast[] = [];
    if (!this.isOp(")")) {
      do args.push(this.parseOr());
      while (this.isOp(",") && this.next());
    }
    const close = this.expectOp(")");
    this.depth--;
    return {
      type: "call",
      name: nameTok.text.toLowerCase(),
      args,
      nameEnd: nameTok.end,
      start: nameTok.start,
      end: close.end,
    };
  }

  private parsePath(): Ast {
    const first = this.next();
    const path = [this.segment(first)];
    let end = first.end;
    while (this.isOp(".")) {
      this.next();
      const seg = this.peek();
      if (seg.kind !== "ident" && seg.kind !== "bracket" && seg.kind !== "kw") {
        throw new ExprError("Expected a field name after '.'", seg.start, seg.end);
      }
      this.next();
      path.push(this.segment(seg));
      end = seg.end;
    }
    return { type: "name", path, start: first.start, end };
  }

  private segment(t: Token): string {
    const name = String(t.value ?? t.text);
    if (BLOCKED_NAMES.has(name)) {
      throw new ExprError(`The name '${name}' is not allowed`, t.start, t.end);
    }
    return name;
  }
}

export function parseSource(src: string): Ast {
  if (typeof src !== "string") throw new ExprError("Expression must be text", 0, 0);
  if (src.length > MAX_SOURCE_LENGTH) {
    throw new ExprError(`Expression is longer than ${MAX_SOURCE_LENGTH} characters`, 0, 0);
  }
  return new Parser(tokenize(src)).parseRoot();
}
