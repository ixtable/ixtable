export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&"
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or";

interface Span {
  start: number;
  end: number;
}

export type Ast = Span &
  (
    | { type: "literal"; value: number | string | boolean | null }
    | { type: "date"; value: string }
    | { type: "name"; path: string[] }
    | { type: "unary"; op: "-" | "not"; operand: Ast }
    | { type: "binary"; op: BinaryOp; left: Ast; right: Ast }
    | { type: "in"; operand: Ast; list: Ast[]; negated: boolean }
    | { type: "between"; operand: Ast; low: Ast; high: Ast; negated: boolean }
    | { type: "isnull"; operand: Ast; negated: boolean }
    | { type: "call"; name: string; args: Ast[]; nameEnd: number }
  );

export type AstOf<T extends Ast["type"]> = Extract<Ast, { type: T }>;

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  start: number;
  end: number;
}

export class ExprError extends Error {
  readonly start: number;
  readonly end: number;

  constructor(message: string, start: number, end: number = start) {
    super(message);
    this.name = "ExprError";
    this.start = start;
    this.end = end;
  }

  get pos(): number {
    return this.start;
  }
}

export function errorAt(node: Span, message: string): ExprError {
  return new ExprError(message, node.start, node.end);
}
