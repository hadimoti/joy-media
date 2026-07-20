/** Coded expression diagnostics — never thrown for expected/untrusted-input failures. */

export interface ExpressionDiagnostic {
  readonly code: string;
  readonly message: string;
}

export function expressionDiagnostic(code: string, message: string): ExpressionDiagnostic {
  return { code, message };
}
