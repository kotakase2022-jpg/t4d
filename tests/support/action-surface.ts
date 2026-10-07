import ts from 'typescript';
import { isUseServer, listFiles, parse, rel } from './static-analysis';

/**
 * Server Action が業務エラー（権限・入力の誤り・対象なし）を利用者へ届けるか（plan §4 B3・§5.2）。
 *
 * 本番の Next.js は Server Action の例外の文を伏せ、error.tsx には digest しか届かない。
 * 業務エラーは withUserFacingError で `?error=` に載せ替えて元の画面に出す。
 * 次のどれかなら「届く」とみなす:
 *  - 本体で withUserFacingError(…) を呼ぶ
 *  - useActionState 形（(前の状態, FormData) の 2 引数）で、結果（エラーの文）を返す
 *  - 戻り値が Promise<void> 以外（結果のオブジェクトを返し、画面が表示する）
 */

export type SurfaceKind = 'wrapped' | 'state' | 'result' | 'unwrapped';

export interface ActionSurface {
  key: string;
  file: string;
  name: string;
  kind: SurfaceKind;
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function callsWrapper(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'withUserFacingError'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function returnsVoid(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): boolean {
  const type = fn.type?.getText(sf).replace(/\s+/g, '') ?? '';
  return type === '' || type === 'Promise<void>' || type === 'void';
}

export function actionSurfaces(): ActionSurface[] {
  const out: ActionSurface[] = [];
  for (const file of listFiles('src')) {
    const sf = parse(file);
    if (!isUseServer(sf)) continue;
    for (const statement of sf.statements) {
      let fn: ts.FunctionLikeDeclaration | null = null;
      let name = '';
      if (ts.isFunctionDeclaration(statement) && statement.name && hasExport(statement)) {
        fn = statement;
        name = statement.name.text;
      } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            fn = decl.initializer;
            name = decl.name.text;
          }
        }
      }
      if (!fn || !name) continue;
      const kind: SurfaceKind = callsWrapper(fn)
        ? 'wrapped'
        : fn.parameters.length >= 2
          ? 'state'
          : !returnsVoid(fn, sf)
            ? 'result'
            : 'unwrapped';
      out.push({ key: `${rel(file)}#${name}`, file: rel(file), name, kind });
    }
  }
  return out;
}
