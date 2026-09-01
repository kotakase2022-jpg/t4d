-- ----------------------------------------------------------------------
-- マテリアリティに「内容」「リスク」「機会」を持たせる
--
-- SSBJ 一般開示基準は、企業の見通しに影響を与えると合理的に見込み得る
-- 「サステナビリティ関連のリスク及び機会」を識別して開示することを求める
-- （第12項(1)・第14項）。さらに第13項は、影響・財務的影響・レジリエンスを
-- **リスク及び機会のそれぞれについて**開示するよう求める。
--
-- マテリアリティ（重要課題）の特定は、この「リスク及び機会の識別」に当たる。
-- 名前だけの課題では戦略の開示（第11項〜）に書く材料が残らないため、
--   - description: 課題の内容の簡潔な説明（区分の提示にも使う）
--   - risks: その課題がもたらすリスク（自由記述）
--   - opportunities: その課題がもたらす機会（自由記述）
-- を課題ごとに持ち、開示ドラフト（戦略の節）の材料へつなぐ。
--
-- 既定 '' の非破壊な列追加。ロールバックは列を無視するだけでよい
-- （docs/known-limitations.md §6）。RLS は既存ポリシーがそのまま適用される。
-- ----------------------------------------------------------------------

alter table materiality_topics
  add column description text not null default '',
  add column risks text not null default '',
  add column opportunities text not null default '';

comment on column materiality_topics.description is
  '課題の内容の簡潔な説明。区分の提示（名前と内容を合わせて判断）にも使う。';
comment on column materiality_topics.risks is
  'この課題がもたらすリスク（SSBJ 一般-12(1)・一般-14 の識別、戦略開示の材料）。';
comment on column materiality_topics.opportunities is
  'この課題がもたらす機会（SSBJ 一般-12(1)・一般-14 の識別、戦略開示の材料）。';
