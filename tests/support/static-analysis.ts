import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * 静的な検査（Server Action の到達性・ルートの到達性・業務エラーの包み直し・UI の段階的上限）が共有する
 * ソースの読み取り。TypeScript の AST を使う（文字列の grep では import の別名・コメントを取り違える）。
 */

export const ROOT = process.cwd();

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** リポジトリからの相対パス（posix） */
export function rel(path: string): string {
  return toPosix(relative(ROOT, path));
}

export function listFiles(dir: string, pattern: RegExp = /\.(ts|tsx)$/): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (pattern.test(name)) out.push(path);
    }
  };
  walk(join(ROOT, dir));
  return out.sort();
}

const cache = new Map<string, ts.SourceFile>();

export function parse(file: string): ts.SourceFile {
  const cached = cache.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  cache.set(file, source);
  return source;
}

/** 先頭の文が 'use server' のモジュールか */
export function isUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

export interface ExportedName {
  name: string;
  line: number;
}

/** モジュールが export する関数・定数の名前（型は除く） */
export function exportedValueNames(sf: ts.SourceFile): ExportedName[] {
  const out: ExportedName[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      out.push({ name: statement.name.text, line: lineOf(statement) });
    } else if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.text, line: lineOf(decl) });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause
    ) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) out.push({ name: element.name.text, line: lineOf(element) });
        }
      }
    }
  }
  return out;
}

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** import の指定子を実ファイルへ解決する（@/ と相対パスだけ。外部パッケージは null） */
export function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = join(dirname(fromFile), specifier);
  else return null;
  base = normalize(base);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ImportInfo {
  specifier: string;
  resolved: string | null;
  /** 名前付き import（imported はモジュール側の名前、local はこのファイルでの名前） */
  names: Array<{ imported: string; local: string }>;
  typeOnly: boolean;
  /** 動的 import（await import('…')）か */
  dynamic: boolean;
}

export function importsOf(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const names: Array<{ imported: string; local: string }> = [];
    const clause = statement.importClause;
    const typeOnly = Boolean(clause?.isTypeOnly);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        names.push({
          imported: (element.propertyName ?? element.name).text,
          local: element.name.text,
        });
      }
    }
    out.push({
      specifier,
      resolved: resolveImport(sf.fileName, specifier),
      names,
      typeOnly,
      dynamic: false,
    });
  }
  // テスト・ページで使う await import('@/…') も参照として数える（分割の都合で静的 import にしないもの）
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      out.push({
        specifier,
        resolved: resolveImport(sf.fileName, specifier),
        names: [],
        typeOnly: false,
        dynamic: true,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** import 文の外で、その名前の識別子が何回使われているか */
export function identifierUses(sf: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

/** ファイルの中の文字列リテラル・テンプレートの静的部分（リンク・リダイレクトの行き先を拾う） */
export function stringLiterals(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      // `${a}/x/${b}` は 1 セグメントの値として [*] に置き換える
      let text = node.head.text;
      for (const span of node.templateSpans) text += `[*]${span.literal.text}`;
      out.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
