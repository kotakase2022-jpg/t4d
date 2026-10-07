import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * UI の段階的上限（ratchet）と指標の数え方（docs/ui-redesign/plan.md §0.2・§3.4-4）。
 *
 * tests/unit/ui-ratchet.test.ts（件数が基準値以下）と scripts/ui-metrics.ts（before／after の記録）が
 * 同じ関数で数える。Stage B は件数を増やせない（減らすのは自由）。Stage C が基準値を最終値に下げ、
 * 0 にできるものは ESLint のエラーにする。
 *
 * 数える場所は src のうち画面とその部品（定義そのもの＝ui の部品・globals.css は除く）。
 */

export const RATCHET_KEYS = [
  'arbitraryTextSize',
  'hexColorClass',
  'numericZIndex',
  'arbitraryShadow',
  'tailwindRounded',
  'variantOutline',
  'rawDetails',
  'rawSelect',
  'rawCheckbox',
  'card',
  'buttonTypeSubmit',
  'buttonVariantsDirect',
  'localToneType',
  'titleAttribute',
  'dialogWithManyInputs',
  'legacyEmptyState',
] as const;
export type RatchetKey = (typeof RATCHET_KEYS)[number];

export const RATCHET_LABELS: Record<RatchetKey, string> = {
  arbitraryTextSize: '任意値の文字サイズ（text-[Npx]）',
  hexColorClass: 'クラスの中の hex 直書き（-[#…]）',
  numericZIndex: '数値の z-index（z-10・z-[1] など）',
  arbitraryShadow: '任意値の影（shadow-[…]）',
  tailwindRounded: 'Tailwind 既定の角丸（rounded-sm/md/lg/xl）',
  variantOutline: 'Button の旧 variant="outline"',
  rawDetails: '素の <details>（Collapsible・MoreInfo・FormSection を通らない）',
  rawSelect: '素の <select>（NativeSelect を通らない）',
  rawCheckbox: '素の checkbox（NativeCheckbox を通らない）',
  card: 'Card（装飾の枠。Section へ寄せる）',
  buttonTypeSubmit: 'Button type="submit"（SubmitButton を使う）',
  buttonVariantsDirect: 'buttonVariants( の直使用',
  localToneType: '画面ローカルの type Tone（状態登録簿へ寄せる）',
  titleAttribute: 'title= の補足説明（Hint・sr-only へ）',
  dialogWithManyInputs: '入力が 7 つ以上ある Dialog（専用ページ・CreatePanel へ）',
  legacyEmptyState: '種類（kind）の無い EmptyState',
};

/** 部品の定義そのもの（ここで使うのは正しい）。数えない */
const DEFINITION_FILES = new Set([
  'src/components/ui/button.tsx',
  'src/components/ui/submit-button.tsx',
  'src/components/ui/icon-button.tsx',
  'src/components/ui/collapsible.tsx',
  'src/components/ui/more-info.tsx',
  'src/components/ui/form-section.tsx',
  'src/components/ui/native-select.tsx',
  'src/components/ui/native-checkbox.tsx',
  'src/components/ui/card.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/ui/badge.tsx',
  'src/components/shared/states.tsx',
]);

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function listTsx(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  };
  walk(join(root, dir));
  return out.sort();
}

function countRegex(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

function tagNameOf(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return node.tagName.getText();
}

const INPUT_TAGS = new Set(['Input', 'Textarea', 'input', 'textarea', 'select', 'NativeSelect']);

interface AstCounts {
  rawDetails: number;
  rawSelect: number;
  rawCheckbox: number;
  card: number;
  buttonTypeSubmit: number;
  titleAttribute: number;
  dialogWithManyInputs: number;
  legacyEmptyState: number;
  variantOutline: number;
}

function astCounts(sf: ts.SourceFile): AstCounts {
  const counts: AstCounts = {
    rawDetails: 0,
    rawSelect: 0,
    rawCheckbox: 0,
    card: 0,
    buttonTypeSubmit: 0,
    titleAttribute: 0,
    dialogWithManyInputs: 0,
    legacyEmptyState: 0,
    variantOutline: 0,
  };
  const attr = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) =>
    node.attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
    );
  const attrText = (a: ts.JsxAttribute | undefined) =>
    a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : null;

  // 同じファイルの部品（例: ダイアログの中の <MetricForm />）は中身まで数える（1 ファイル内だけ）
  const localComponents = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      /^[A-Z]/.test(statement.name.text)
    ) {
      if (statement.body) localComponents.set(statement.name.text, statement.body);
    }
  }
  const inputsWithin = (node: ts.Node, expanding: Set<string> = new Set()): number => {
    let n = 0;
    const visit = (child: ts.Node) => {
      if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
        const tag = tagNameOf(child);
        const type = attrText(attr(child, 'type'));
        if (INPUT_TAGS.has(tag) && type !== 'hidden') n += 1;
        const local = localComponents.get(tag);
        if (local && !expanding.has(tag)) {
          n += inputsWithin(local, new Set([...expanding, tag]));
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return n;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagNameOf(node);
      if (tag === 'details') counts.rawDetails += 1;
      if (tag === 'select') counts.rawSelect += 1;
      if (tag === 'input' && attrText(attr(node, 'type')) === 'checkbox') counts.rawCheckbox += 1;
      if (tag === 'Card') counts.card += 1;
      if (tag === 'Button' && attrText(attr(node, 'type')) === 'submit')
        counts.buttonTypeSubmit += 1;
      if (
        (tag === 'Button' || tag === 'SubmitButton') &&
        attrText(attr(node, 'variant')) === 'outline'
      ) {
        counts.variantOutline += 1;
      }
      // iframe の title は補足ではなく読み上げ名（必須。axe frame-title）なので数えない
      if (attr(node, 'title') && (/^[a-z]/.test(tag) || tag === 'Badge') && tag !== 'iframe')
        counts.titleAttribute += 1;
      if (tag === 'EmptyState' && !attr(node, 'kind')) counts.legacyEmptyState += 1;
    }
    if (ts.isJsxElement(node) && tagNameOf(node.openingElement) === 'DialogContent') {
      if (inputsWithin(node) >= 7) counts.dialogWithManyInputs += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

export type RatchetCounts = Record<RatchetKey, number>;

export interface RatchetReport {
  totals: RatchetCounts;
  /** ファイルごとの件数（0 のものは省く）。どこで増えたかを示す */
  byFile: Record<string, Partial<RatchetCounts>>;
}

export function measureRatchet(root: string = process.cwd()): RatchetReport {
  const totals = Object.fromEntries(RATCHET_KEYS.map((k) => [k, 0])) as RatchetCounts;
  const byFile: Record<string, Partial<RatchetCounts>> = {};
  for (const file of listTsx(root, 'src')) {
    const relPath = toPosix(relative(root, file));
    if (DEFINITION_FILES.has(relPath)) continue;
    const text = readFileSync(file, 'utf8');
    const counts: Partial<RatchetCounts> = {
      arbitraryTextSize: countRegex(text, /(?<=[\s"'`:!])text-\[\d+(?:\.\d+)?px\]/g),
      hexColorClass: countRegex(text, /(?<=[\s"'`:!])[a-z-]+-\[#[0-9a-fA-F]{3,8}\]/g),
      numericZIndex: countRegex(text, /(?<=[\s"'`:!])-?z-(?:\d+|\[\d+\])(?=[\s"'`])/g),
      arbitraryShadow: countRegex(text, /(?<=[\s"'`:!])shadow-\[/g),
      tailwindRounded: countRegex(text, /(?<=[\s"'`:!])rounded-(?:sm|md|lg|xl)(?=[\s"'`])/g),
      buttonVariantsDirect: countRegex(text, /\bbuttonVariants\(/g),
      localToneType: countRegex(text, /\btype Tone\b/g),
    };
    if (file.endsWith('.tsx')) {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      Object.assign(counts, astCounts(sf));
    }
    const nonZero: Partial<RatchetCounts> = {};
    for (const key of RATCHET_KEYS) {
      const n = counts[key] ?? 0;
      totals[key] += n;
      if (n > 0) nonZero[key] = n;
    }
    if (Object.keys(nonZero).length > 0) byFile[relPath] = nonZero;
  }
  return { totals, byFile };
}
