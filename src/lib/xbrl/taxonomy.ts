import type {
  XbrlConcept,
  XbrlConceptKind,
  XbrlLicenseStatus,
  XbrlPackageLegalStatus,
  XbrlProfile,
  XbrlTaxonomyPackage,
} from '@/types/domain';
import { SAMPLE_UNIT_RULES } from './sample-taxonomy';

/**
 * XBRL のタクソノミのパッケージ（トライアル対応 NF-42 Stage 1。plan §3.4）。
 *
 * SAMPLE（架空）と公式（EDINET・ESRS。Stage 2 で読み込む）を**同じ型**で扱う。画面・出力・検査は
 * この型だけを見て、パッケージがサンプルかどうか・提出用にできるかを判断する（名前で判断しない）。
 *
 * DB にも画面にも依存しない純粋関数だけを置く（別のインスタンスで同じ結果になるように）。
 */

/** 概念の値の種類（データ型から決める。単位・値の検査に使う） */
export type ConceptValueClass =
  'monetary' | 'percent' | 'integer' | 'decimal' | 'text_block' | 'string' | 'none';

export interface TaxonomyConcept {
  id: string;
  prefix: string;
  localName: string;
  namespaceUri: string;
  kind: XbrlConceptKind;
  dataType: string;
  periodType: 'duration' | 'instant' | null;
  labelJa: string;
  labelEn: string;
  parentLocalName: string | null;
  deprecated: boolean;
  sortOrder: number;
}

/**
 * 単位の規則（概念 → 使ってよい measure）。表に無い概念はデータ型の規則だけで見る。
 * 例: SAMPLE の GHG 排出量は utr:tCO2e だけ（EDINET の規則を先取りする。千 t・百万 t は換算してから）
 */
export type UnitRules = Readonly<Record<string, readonly string[]>>;

export interface TaxonomyPackage {
  id: string;
  key: string;
  frameworkKey: string;
  profile: XbrlProfile;
  name: string;
  versionLabel: string;
  publisher: string;
  legalStatus: XbrlPackageLegalStatus;
  licenseStatus: XbrlLicenseStatus;
  licenseNote: string;
  namespaceUri: string;
  prefix: string;
  entryPoint: string;
  /** 提出用のファイルを作れる版か（Stage 1 は常に false。V16 で常に注記する） */
  filingReady: boolean;
  isSample: boolean;
  concepts: TaxonomyConcept[];
  unitRules: UnitRules;
}

export const XBRL_PROFILE_LABELS: Record<XbrlProfile, string> = {
  sample: 'サンプル（架空）',
  edinet_ssbj: 'EDINET（SSBJ 基準の適用企業）',
  edinet_non_ssbj: 'EDINET（SSBJ 基準の非適用企業）',
  esrs: 'ESRS（ESEF）',
  esrs_40a: 'ESRS-40a',
};

export const XBRL_LEGAL_STATUS_LABELS: Record<XbrlPackageLegalStatus, string> = {
  sample: 'サンプル（架空・公式ではない）',
  draft: '草案',
  final: '確定版',
  superseded: '置き換え済み',
};

export const XBRL_LICENSE_STATUS_LABELS: Record<XbrlLicenseStatus, string> = {
  not_required: '利用許諾は不要',
  required_pending: '利用許諾が必要（未取得）',
  granted: '利用許諾を取得済み',
};

/** 値を持つ概念（事実を付けられる概念）。抽象・軸・メンバーには値を付けない（V14） */
export function isValueConcept(concept: Pick<TaxonomyConcept, 'kind'>): boolean {
  return concept.kind === 'item' || concept.kind === 'text_block';
}

/** 概念の値の種類。データ型の名前（接頭辞を除いた部分）から決める */
export function conceptValueClass(
  concept: Pick<TaxonomyConcept, 'kind' | 'dataType'>,
): ConceptValueClass {
  if (concept.kind === 'text_block') return 'text_block';
  if (concept.kind !== 'item') return 'none';
  const type = (concept.dataType.split(':').pop() ?? '').toLowerCase();
  if (type.startsWith('textblock')) return 'text_block';
  if (type.startsWith('monetary')) return 'monetary';
  if (type.startsWith('percent') || type.startsWith('pure')) return 'percent';
  if (type.startsWith('integer') || type.startsWith('nonnegativeinteger')) return 'integer';
  if (
    type.startsWith('decimal') ||
    type.startsWith('ghgemissions') ||
    type.startsWith('energy') ||
    type.startsWith('volume') ||
    type.startsWith('mass') ||
    type.startsWith('area')
  ) {
    return 'decimal';
  }
  return 'string';
}

/** 数値の概念か（単位・decimals が要る） */
export function isNumericConcept(concept: Pick<TaxonomyConcept, 'kind' | 'dataType'>): boolean {
  const cls = conceptValueClass(concept);
  return cls === 'monetary' || cls === 'percent' || cls === 'integer' || cls === 'decimal';
}

/** 接頭辞付きの名前（例: t4ds:SampleScope1GhgEmissions） */
export function conceptQName(concept: Pick<TaxonomyConcept, 'prefix' | 'localName'>): string {
  return `${concept.prefix}:${concept.localName}`;
}

/** DB の行（0053）からパッケージを組み立てる。概念は並び順で並べる */
export function buildTaxonomyPackage(
  row: Pick<
    XbrlTaxonomyPackage,
    | 'id'
    | 'key'
    | 'frameworkKey'
    | 'profile'
    | 'name'
    | 'versionLabel'
    | 'publisher'
    | 'legalStatus'
    | 'licenseStatus'
    | 'licenseNote'
    | 'namespaceUri'
    | 'prefix'
    | 'entryPoint'
    | 'filingReady'
    | 'isFixture'
  >,
  conceptRows: readonly Pick<
    XbrlConcept,
    | 'id'
    | 'packageId'
    | 'prefix'
    | 'localName'
    | 'namespaceUri'
    | 'kind'
    | 'dataType'
    | 'periodType'
    | 'labelJa'
    | 'labelEn'
    | 'parentId'
    | 'deprecated'
    | 'sortOrder'
  >[],
): TaxonomyPackage {
  const own = conceptRows.filter((c) => c.packageId === row.id);
  const nameById = new Map(own.map((c) => [c.id, c.localName]));
  const concepts: TaxonomyConcept[] = own
    .map((c) => ({
      id: c.id,
      prefix: c.prefix,
      localName: c.localName,
      namespaceUri: c.namespaceUri,
      kind: c.kind,
      dataType: c.dataType,
      periodType: c.periodType,
      labelJa: c.labelJa,
      labelEn: c.labelEn,
      parentLocalName: c.parentId ? (nameById.get(c.parentId) ?? null) : null,
      deprecated: c.deprecated,
      sortOrder: c.sortOrder,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.localName < b.localName ? -1 : 1));
  const isSample = row.profile === 'sample' || row.legalStatus === 'sample';
  return {
    id: row.id,
    key: row.key,
    frameworkKey: row.frameworkKey,
    profile: row.profile,
    name: row.name,
    versionLabel: row.versionLabel,
    publisher: row.publisher,
    legalStatus: row.legalStatus,
    licenseStatus: row.licenseStatus,
    licenseNote: row.licenseNote,
    namespaceUri: row.namespaceUri,
    prefix: row.prefix,
    entryPoint: row.entryPoint,
    // DB の CHECK と同じ条件を重ねる（サンプル・草案・ライセンス未取得・Fixture は提出用にしない）
    filingReady:
      row.filingReady &&
      !isSample &&
      row.legalStatus === 'final' &&
      row.licenseStatus !== 'required_pending' &&
      !row.isFixture,
    isSample,
    concepts,
    unitRules: isSample ? SAMPLE_UNIT_RULES : {},
  };
}

export function findConcept(
  pkg: Pick<TaxonomyPackage, 'concepts'>,
  localName: string,
): TaxonomyConcept | null {
  return pkg.concepts.find((c) => c.localName === localName) ?? null;
}

export function findConceptById(
  pkg: Pick<TaxonomyPackage, 'concepts'>,
  id: string,
): TaxonomyConcept | null {
  return pkg.concepts.find((c) => c.id === id) ?? null;
}

/** 軸と、その軸に属するメンバー（パッケージの親子関係から） */
export function axesOf(
  pkg: Pick<TaxonomyPackage, 'concepts'>,
): Array<{ axis: TaxonomyConcept; members: TaxonomyConcept[] }> {
  return pkg.concepts
    .filter((c) => c.kind === 'axis' && !c.deprecated)
    .map((axis) => ({
      axis,
      members: pkg.concepts.filter(
        (m) => m.kind === 'member' && m.parentLocalName === axis.localName && !m.deprecated,
      ),
    }));
}

/** 値を付けられる概念（対応付けの選択肢）。数値の概念と文章の概念に分ける */
export function valueConceptsOf(pkg: Pick<TaxonomyPackage, 'concepts'>): {
  numeric: TaxonomyConcept[];
  textBlocks: TaxonomyConcept[];
} {
  const values = pkg.concepts.filter((c) => isValueConcept(c) && !c.deprecated);
  return {
    numeric: values.filter((c) => conceptValueClass(c) !== 'text_block'),
    textBlocks: values.filter((c) => conceptValueClass(c) === 'text_block'),
  };
}
