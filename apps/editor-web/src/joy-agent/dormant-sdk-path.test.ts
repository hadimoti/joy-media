import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const editorSourceRoot = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED_COMPATIBILITY_FILES = new Set(['joy-agent/tool-bridge.ts']);

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    if (!entry.isFile()) return [];
    if (extname(entry.name) !== '.ts' && extname(entry.name) !== '.tsx') return [];
    if (entry.name.endsWith('.d.ts') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
      return [];
    return [path];
  });
}

function namedImportActivatesDormantSdk(node: ts.ImportDeclaration): string | undefined {
  const bindings = node.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return undefined;
  for (const binding of bindings.elements) {
    const importedName = binding.propertyName?.text ?? binding.name.text;
    if (importedName === 'createJoyAgentToolBridge' || importedName === 'ToolLoopAgent')
      return importedName;
  }
  return undefined;
}

function activationName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

function activationViolations(path: string): string[] {
  const displayPath = relative(editorSourceRoot, path).replaceAll('\\', '/');
  if (ALLOWED_COMPATIBILITY_FILES.has(displayPath)) return [];
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const report = (node: ts.Node, name: string) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${displayPath}:${line + 1}:${character + 1} activates ${name}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const name = namedImportActivatesDormantSdk(node);
      if (name !== undefined) report(node, name);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = activationName(node.expression);
      if (name === 'createJoyAgentToolBridge' || name === 'ToolLoopAgent') report(node, name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('JOY Agent dormant SDK architecture guard', () => {
  it('keeps the compatibility bridge and ToolLoopAgent path out of production editor activation', () => {
    const violations = productionSourceFiles(editorSourceRoot).flatMap(activationViolations);

    expect(
      violations,
      'Production editor code must enter through the Worker and trusted host RPC, not the dormant SDK bridge.',
    ).toEqual([]);
  });
});
