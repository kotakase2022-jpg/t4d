import type { ActivityColumnMapping } from '@/lib/domain/ghg/activity-parse';
import type { GhgBatchKind } from '@/types/domain';

/**
 * 活動量の取込の列の対応付け（plan P94・CR-05。unit:ghg-activity-mapping）。純関数。
 *
 * ファイルの列名から取込の項目への対応を提案し（同じ列を 2 つの項目に当てない）、利用者が選んだ対応を
 * 検査する。読めない・足りない対応は推測で埋めずに理由を返す（取込はしない）。
 * 単位を取り違えると桁違いになる項目（輸送重量は t、最大積載量は kg、積載率は %）は、列名の単位の語が
 * 食い違っていれば対応付けの段で止める（調査メモ §2.9: z を t で入れると致命的、y を割合で入れると約 40 倍）。
 *
 * 画面（クライアント）とサービス（サーバー）が同じ規則を使う。
 */

export type ActivityMappingField = Exclude<keyof ActivityColumnMapping, 'decimalSeparator'>;

/** 利用者が選んだ対応（項目 → ファイルの列名）。未選択の項目は持たない */
export type ActivityMappingSelection = Partial<Record<ActivityMappingField, string>>;

export interface MappingFieldSpec {
  key: ActivityMappingField;
  label: string;
  /** required: 必ず要る／optional: 任意（一部は組み合わせで必須。validateActivityMapping が見る） */
  need: 'required' | 'optional';
  hint?: string;
  /** 列名の候補（正規化した形。normalizeHeader と同じ規則） */
  synonyms: readonly string[];
}

const ENERGY_FIELDS: readonly MappingFieldSpec[] = [
  {
    key: 'month',
    label: '月',
    need: 'required',
    hint: '2025-07・2025/7・2025年7月 の形',
    synonyms: ['月', '年月', '対象月', '計上月', 'month', 'yearmonth'],
  },
  {
    key: 'activity',
    label: '活動',
    need: 'required',
    hint: '電力・軽油・揮発油・都市ガス など',
    synonyms: [
      '活動',
      '活動種類',
      '種類',
      'エネルギー',
      'エネルギー種類',
      '燃料種',
      'activity',
      'energy',
    ],
  },
  {
    key: 'amount',
    label: '量',
    need: 'required',
    synonyms: ['量', '使用量', '活動量', '数量', 'amount', 'quantity', 'value'],
  },
  {
    key: 'unit',
    label: '単位',
    need: 'required',
    hint: 'kWh・L・kL・gal・m3・Nm3 など（読めない単位は取り込みません）',
    synonyms: ['単位', 'unit'],
  },
  {
    key: 'contractCode',
    label: '電力の契約',
    need: 'optional',
    hint: 'マーケット基準の係数の割当に使います',
    synonyms: ['契約', '契約コード', '電力契約', 'contract', 'contractcode'],
  },
  {
    key: 'note',
    label: '備考',
    need: 'optional',
    synonyms: ['備考', 'メモ', '注記', 'note', 'remarks', 'comment'],
  },
];

const TRANSPORT_FIELDS: readonly MappingFieldSpec[] = [
  {
    key: 'month',
    label: '月',
    need: 'required',
    hint: '2025-07・2025/7・2025年7月 の形',
    synonyms: ['月', '年月', '対象月', '計上月', '輸送月', 'month', 'yearmonth'],
  },
  {
    key: 'carrierKind',
    label: '輸送の区分（委託・自社便）',
    need: 'required',
    hint: '「委託物流」「自社便」など',
    synonyms: ['輸送区分', '輸送担い手', '委託自社', '委託自社便', 'carrier', 'carrierkind'],
  },
  {
    key: 'fuel',
    label: '燃料',
    need: 'required',
    hint: '軽油・揮発油',
    synonyms: ['燃料', '燃料種', '燃料種類', 'fuel'],
  },
  {
    key: 'shipmentRef',
    label: '出荷番号',
    need: 'optional',
    hint: '既存の算定結果との突き合わせと、重複の確認に使います',
    synonyms: [
      '出荷番号',
      '伝票番号',
      '出荷no',
      '輸送番号',
      'shipment',
      'shipmentref',
      'shipmentno',
    ],
  },
  {
    key: 'cargoWeightT',
    label: '輸送重量（t）',
    need: 'optional',
    hint: 't（トン）で。重量 × 距離 か t·km のどちらかが要ります',
    synonyms: ['輸送重量', '貨物重量', '重量', '積載重量', 'weight', 'cargoweight'],
  },
  {
    key: 'distanceKm',
    label: '輸送距離（km）',
    need: 'optional',
    synonyms: ['輸送距離', '距離', '走行距離', 'distance'],
  },
  {
    key: 'tonKm',
    label: '輸送トンキロ（t·km）',
    need: 'optional',
    hint: 'ファイルに t·km があれば重量 × 距離より優先します',
    synonyms: ['トンキロ', '輸送トンキロ', 'tkm', 'tonkm'],
  },
  {
    key: 'maxPayloadKg',
    label: '最大積載量（kg）',
    need: 'optional',
    hint: 'kg で（t で入れると桁が 1,000 倍違います）',
    synonyms: ['最大積載量', '積載量', 'maxpayload', 'payload'],
  },
  {
    key: 'loadFactorPct',
    label: '積載率（%）',
    need: 'optional',
    hint: '% で。無い行は見なし積載率の原単位表で算定します',
    synonyms: ['積載率', 'loadfactor'],
  },
  {
    key: 'fuelEconomyClass',
    label: '燃費の区分',
    need: 'optional',
    hint: '2025年度基準・2022年度基準・2015年度基準・未確認',
    synonyms: ['燃費区分', '燃費基準', '燃費基準区分', 'fueleconomy', 'economyclass'],
  },
  {
    key: 'vehicleUse',
    label: '用途（事業用・自家用）',
    need: 'optional',
    hint: '無ければ委託は事業用として扱います',
    synonyms: ['用途', '事業用自家用', '営業用自家用', 'vehicleuse'],
  },
  {
    key: 'cargoKind',
    label: '貨物',
    need: 'optional',
    synonyms: ['貨物', '貨物区分', '品目', 'cargo', 'cargokind'],
  },
  {
    key: 'amount',
    label: '燃料の量（燃料法）',
    need: 'optional',
    hint: '自社便などで燃料の使用量が分かる行',
    synonyms: ['燃料量', '燃料使用量', '給油量', 'fuelamount'],
  },
  {
    key: 'unit',
    label: '燃料の単位（燃料法）',
    need: 'optional',
    synonyms: ['燃料単位', '単位', 'unit'],
  },
  {
    key: 'note',
    label: '備考',
    need: 'optional',
    synonyms: ['備考', 'メモ', '注記', 'note', 'remarks', 'comment'],
  },
];

export function activityMappingFields(kind: GhgBatchKind): readonly MappingFieldSpec[] {
  return kind === 'energy' ? ENERGY_FIELDS : TRANSPORT_FIELDS;
}

const FIELD_KEYS = new Set<string>([...ENERGY_FIELDS, ...TRANSPORT_FIELDS].map((f) => f.key));

/** 列名の正規化（全角・大小・空白・括弧の中・区切り記号・助詞「の」を落とす） */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[\s・·_\-‐/／.。:：]/g, '')
    .replace(/の/g, '');
}

/** 列名の括弧の中（単位の語。例「輸送重量(kg)」→ "kg"） */
function unitWordOf(raw: string): string {
  const m = /[([]([^)\]]*)[)\]]/.exec(raw.normalize('NFKC'));
  return (m?.[1] ?? '').toLowerCase().replace(/\s/g, '');
}

/**
 * 列名から対応を提案する。完全一致（正規化後）を先に当て、次に前方一致。1 つの列は 1 つの項目にだけ当てる
 */
export function suggestActivityMapping(
  headers: readonly string[],
  kind: GhgBatchKind,
): ActivityMappingSelection {
  const fields = activityMappingFields(kind);
  const normalized = headers.map((h) => ({ header: h, norm: normalizeHeader(h) }));
  const used = new Set<string>();
  const out: ActivityMappingSelection = {};
  const assign = (match: (norm: string, synonym: string) => boolean) => {
    for (const field of fields) {
      if (out[field.key]) continue;
      const hit = normalized.find(
        (h) => !used.has(h.header) && h.norm !== '' && field.synonyms.some((s) => match(h.norm, s)),
      );
      if (hit) {
        out[field.key] = hit.header;
        used.add(hit.header);
      }
    }
  };
  assign((norm, synonym) => norm === synonym);
  // 前方一致は 2 文字以上の候補だけ（「月」「量」で別の列を拾わない）
  assign((norm, synonym) => synonym.length >= 2 && norm.startsWith(synonym));
  return out;
}

/** フォームの JSON から対応を取り出す（知らない項目・文字列でない値は捨てる） */
export function parseMappingSelection(raw: string | null | undefined): ActivityMappingSelection {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ActivityMappingSelection = {};
  for (const [key, header] of Object.entries(value as Record<string, unknown>)) {
    if (FIELD_KEYS.has(key) && typeof header === 'string' && header.trim() !== '') {
      out[key as ActivityMappingField] = header;
    }
  }
  return out;
}

export interface MappingValidation {
  /** 取込に使う対応（問題があれば null） */
  mapping: ActivityColumnMapping | null;
  problems: string[];
}

/**
 * 選んだ対応を検査する。ファイルに無い列・同じ列の 2 重の割当・必須の項目の欠け・組み合わせで要る項目・
 * 列名の単位の語の食い違いを、項目名つきの文で返す
 */
export function validateActivityMapping(
  selection: ActivityMappingSelection,
  headers: readonly string[],
  kind: GhgBatchKind,
): MappingValidation {
  const fields = activityMappingFields(kind);
  const allowed = new Set(fields.map((f) => f.key));
  const labelOf = (key: ActivityMappingField) => fields.find((f) => f.key === key)?.label ?? key;
  const problems: string[] = [];
  const picked: ActivityMappingSelection = {};
  for (const [key, header] of Object.entries(selection) as Array<[ActivityMappingField, string]>) {
    if (!allowed.has(key)) continue;
    if (!headers.includes(header)) {
      problems.push(`${labelOf(key)}: 列「${header}」がファイルにありません。`);
      continue;
    }
    picked[key] = header;
  }
  const byHeader = new Map<string, ActivityMappingField[]>();
  for (const [key, header] of Object.entries(picked) as Array<[ActivityMappingField, string]>) {
    byHeader.set(header, [...(byHeader.get(header) ?? []), key]);
  }
  for (const [header, keys] of byHeader) {
    if (keys.length > 1) {
      problems.push(
        `列「${header}」を ${keys.map(labelOf).join('・')} の 2 つ以上に当てています。`,
      );
    }
  }
  for (const field of fields) {
    if (field.need === 'required' && !picked[field.key]) {
      problems.push(`${field.label}の列を選んでください。`);
    }
  }
  if (kind === 'transport') {
    const tonKmGiven = !!picked.tonKm || (!!picked.cargoWeightT && !!picked.distanceKm);
    const fuelGiven = !!picked.amount && !!picked.unit;
    if (!tonKmGiven && !fuelGiven) {
      problems.push(
        '輸送重量と輸送距離、または輸送トンキロ（燃料法なら燃料の量と単位）の列を選んでください。',
      );
    }
    if (!!picked.cargoWeightT !== !!picked.distanceKm && !picked.tonKm) {
      problems.push('輸送重量と輸送距離は両方を選んでください（片方だけでは t·km を作れません）。');
    }
    if (tonKmGiven) {
      if (!picked.maxPayloadKg) {
        problems.push('改良トンキロ法には最大積載量（kg）の列が要ります。');
      }
      if (!picked.fuelEconomyClass) {
        problems.push(
          '改良トンキロ法には燃費の区分の列が要ります（不明な車両は「未確認」と書きます）。',
        );
      }
    }
    const weightUnit = picked.cargoWeightT ? unitWordOf(picked.cargoWeightT) : '';
    if (/^(kg|キログラム)/.test(weightUnit)) {
      problems.push(
        `輸送重量の列「${picked.cargoWeightT}」は kg のようです。輸送重量は t（トン）で入れてください。`,
      );
    }
    const payloadUnit = picked.maxPayloadKg ? unitWordOf(picked.maxPayloadKg) : '';
    if (/^(t|トン)$/.test(payloadUnit)) {
      problems.push(
        `最大積載量の列「${picked.maxPayloadKg}」は t のようです。最大積載量は kg で入れてください。`,
      );
    }
    const loadUnit = picked.loadFactorPct ? unitWordOf(picked.loadFactorPct) : '';
    if (loadUnit !== '' && !/^(%|％|パーセント)$/.test(loadUnit)) {
      problems.push(
        `積載率の列「${picked.loadFactorPct}」の単位が % ではありません。積載率は % で入れてください。`,
      );
    }
  }
  if (problems.length > 0 || !picked.month) return { mapping: null, problems };
  return { mapping: { ...picked, month: picked.month }, problems };
}
