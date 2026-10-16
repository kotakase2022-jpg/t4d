import Link from 'next/link';
import { Download } from 'lucide-react';
import { GhgNotice } from '@/components/shared/ghg-notices';
import { Section } from '@/components/shared/section';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import {
  GUIDELINE_MIN_LOAD_PCT,
  PRESET_FUEL_CO2,
  PRESET_FUEL_LABELS,
  PRESET_FUELS,
  TONKM_PRESET_FUELS,
  TONKM_PRESET_SOURCES,
  payloadRangeLabel,
  verifyPresetDefaultTable,
} from '@/lib/domain/ghg/tonkm-preset';
import {
  PRESET_FUEL_CO2_EDITION_LABELS,
  PRESET_FUEL_CO2_EDITIONS,
  presetFactorSetHref,
} from '@/lib/exports/ghg-preset-factor-set';
import { formatNumber } from '@/lib/format/datetime';
import { FUEL_ECONOMY_CLASSES } from '@/types/domain';
import { ECONOMY_CLASS_LABELS, VEHICLE_USE_LABELS } from '../_lib/labels';

/**
 * 改良トンキロ法の公的参照プリセット（plan CR-19・D3・固定文 N10）。閲覧だけ。
 *
 * 既定では算定に使わない（算定は係数セットの行と組織の算定方針だけ）。組織が採用を決めたときに、取込用の
 * CSV（E21）を排出係数の画面で係数セット（下書き・出所「公的参照」）へ取り込む。告示式と別表第3 の検算の結果（一致しないセルの数）も出し、
 * 転記の誤りが無いことを利用者が確かめられるようにする。固定文 N10 は折りたたみの外に置く。
 */
export function TonKmPresetSection({ factorsHref }: { factorsHref: string }) {
  const checks = verifyPresetDefaultTable();
  const mismatches = checks.filter((c) => !c.matches);
  const formulas = PRESET_FUELS.flatMap((fuel) =>
    TONKM_PRESET_FUELS[fuel].formulas.map((f) => ({ fuel, entry: TONKM_PRESET_FUELS[fuel], f })),
  );
  return (
    <Section
      id="tonkm-preset"
      title="公的参照プリセット（改良トンキロ法）"
      summary={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge domain="factorOrigin" value="public_reference" />
          <SemanticBadge semantic="info" label="既定では適用しません" />
        </span>
      }
    >
      <div className="space-y-2">
        <GhgNotice id="N10" />
        <p className="text-small text-ink-muted">
          算定は係数セットの行と組織の算定方針だけを使います。採用するときは、下の取込用の CSV を
          <Link href={factorsHref} className="mx-1 text-brand-700 hover:underline">
            排出係数
          </Link>
          の「係数セットを取り込む」で出所「公的参照」として取り込み（下書きのセットになり、有効にして割り当てるまで算定に使いません）、算定ルールで式の形・積載率の下限（ガイドラインは{' '}
          {GUIDELINE_MIN_LOAD_PCT}%）・範囲外と海外拠点の扱い・原単位の丸めを決めてください。
        </p>
        <ul
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small"
          aria-label="公的参照プリセットの取込用 CSV"
        >
          {PRESET_FUEL_CO2_EDITIONS.map((edition) => (
            <li key={edition}>
              <a
                href={presetFactorSetHref(edition)}
                download
                data-preset-download={edition}
                className="inline-flex items-center gap-1 text-brand-700 hover:underline"
              >
                <Download className="size-3.5" aria-hidden="true" />
                取込用 CSV をダウンロード（{PRESET_FUEL_CO2_EDITION_LABELS[edition]}）
              </a>
            </li>
          ))}
        </ul>
        <div className="t4d-scroll-x">
          <Table>
            <caption className="sr-only">告示の 7 式（貨物輸送量当たりの燃料使用量）</caption>
            <THead>
              <TR>
                <TH>告示の号</TH>
                <TH>燃料</TH>
                <TH>燃費の区分</TH>
                <TH align="right">A</TH>
                <TH align="right">B</TH>
                <TH align="right">S</TH>
                <TH>当てる最大積載量</TH>
                <TH align="right">対数式の定数（比較用）</TH>
              </TR>
            </THead>
            <TBody>
              {formulas.map(({ fuel, entry, f }) => (
                <TR key={`${fuel}-${f.item}`}>
                  <TD>{f.item}</TD>
                  <TD>{PRESET_FUEL_LABELS[fuel]}</TD>
                  <TD className="text-small">{f.label}</TD>
                  <TD align="right" className="tnum">
                    {f.A}
                  </TD>
                  <TD align="right" className="tnum">
                    {f.B}
                  </TD>
                  <TD align="right" className="tnum">
                    {entry.S}
                  </TD>
                  <TD className="text-small">
                    {payloadRangeLabel(f.payloadMinKg, f.payloadMaxKg)}
                  </TD>
                  <TD align="right" className="tnum">
                    {f.economyClass === 'unverified' ? `ln A = ${entry.log.lnA}` : '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <p className="text-caption text-ink-muted">
          式: x = A ÷ (y/100)<sup>S</sup> ÷ z<sup>B</sup>（x: L/(t·km)、y: 積載率 %、z: 最大積載量
          kg）。出典: {TONKM_PRESET_SOURCES.kokuji.label}（{TONKM_PRESET_SOURCES.kokuji.edition}）、
          {TONKM_PRESET_SOURCES.guideline.label}（{TONKM_PRESET_SOURCES.guideline.edition}
          。区分の組み合わせ・対数式）。
        </p>
      </div>
      <Section
        id="tonkm-preset-tables"
        level={3}
        collapsible
        title="見なし積載率の原単位表（告示 別表第3）と燃料の CO2 換算の値"
        summary={`別表第3 の ${checks.length} セルを式で検算: 一致しないのは ${mismatches.length} セル（出典の注記どおり）`}
      >
        <div className="space-y-3">
          {(['commercial', 'private'] as const).map((use) => (
            <div key={use} className="t4d-scroll-x">
              <Table>
                <caption className="px-1 py-1 text-left text-small font-medium text-ink">
                  {VEHICLE_USE_LABELS[use]}の貨物自動車（L/(t·km)。「—」は区分なし）
                </caption>
                <THead>
                  <TR>
                    <TH>燃料</TH>
                    <TH>最大積載量</TH>
                    <TH align="right">中央値（kg）</TH>
                    <TH align="right">見なし積載率</TH>
                    {FUEL_ECONOMY_CLASSES.map((c) => (
                      <TH key={c} align="right">
                        {ECONOMY_CLASS_LABELS[c]}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {PRESET_FUELS.flatMap((fuel) =>
                    TONKM_PRESET_FUELS[fuel].defaults
                      .filter((row) => row.vehicleUse === use)
                      .map((row) => (
                        <TR key={`${fuel}-${row.minKg}`}>
                          <TD>{PRESET_FUEL_LABELS[fuel]}</TD>
                          <TD className="text-small">{payloadRangeLabel(row.minKg, row.maxKg)}</TD>
                          <TD align="right" className="tnum">
                            {formatNumber(row.medianKg)}
                          </TD>
                          <TD align="right" className="tnum">
                            {row.loadPct}%
                          </TD>
                          {FUEL_ECONOMY_CLASSES.map((c) => {
                            const value = row.values[c];
                            const check = checks.find(
                              (x) =>
                                x.fuel === fuel &&
                                x.vehicleUse === use &&
                                x.minKg === row.minKg &&
                                x.economyClass === c,
                            );
                            return (
                              <TD key={c} align="right" className="tnum">
                                {value === undefined ? '—' : value}
                                {check && !check.matches && (
                                  <SemanticBadge
                                    semantic="info"
                                    label={`式では ${check.formula}`}
                                    detail="共同ガイドライン 表 II-22 注3: この欄は関数式によらず 2025年度基準の値を記載。表の値を使います"
                                    className="ml-1"
                                  />
                                )}
                              </TD>
                            );
                          })}
                        </TR>
                      )),
                  )}
                </TBody>
              </Table>
            </div>
          ))}
          <div className="t4d-scroll-x">
            <Table>
              <caption className="px-1 py-1 text-left text-small font-medium text-ink">
                燃料の CO2 換算（t-CO2 = kL × 単位発熱量 × 炭素排出係数 × 44/12）
              </caption>
              <THead>
                <TR>
                  <TH>燃料</TH>
                  <TH align="right">単位発熱量（GJ/kL）</TH>
                  <TH align="right">炭素排出係数（tC/GJ）</TH>
                  <TH>適用する実績の年度</TH>
                  <TH>出典</TH>
                </TR>
              </THead>
              <TBody>
                {PRESET_FUEL_CO2.map((v) => (
                  <TR key={`${v.fuel}-${v.applies}`}>
                    <TD>{PRESET_FUEL_LABELS[v.fuel]}</TD>
                    <TD align="right" className="tnum">
                      {v.calorific.toFixed(1)}
                    </TD>
                    <TD align="right" className="tnum">
                      {v.carbon}
                    </TD>
                    <TD className="text-small">{v.applies}</TD>
                    <TD className="text-caption text-ink-muted">
                      {TONKM_PRESET_SOURCES[v.source].label}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      </Section>
    </Section>
  );
}
