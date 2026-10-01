import { QuestionDetailView } from '../../question-view';
import { requirementDetailPath } from '../requirements/form-input';

export const metadata = { title: 'CSRD 開示項目' };

/**
 * CSRD の回答（版・承認・AI 回答ドラフト）。CDP と同じ共有ビューをそのまま使う。
 * 要求事項の評価（適用・3 観点・計画）は要求事項の詳細にあるため、そこへ戻る導線を付ける
 * （docs/disclosure-first.md §9.4）
 */
export default async function CsrdQuestionPage({
  params,
}: {
  params: Promise<{ questionId: string }>;
}) {
  const { questionId } = await params;
  return (
    <QuestionDetailView
      frameworkKey="csrd"
      frameworkLabel="CSRD"
      basePath="/enterprise/disclosures/csrd"
      questionId={questionId}
      backLink={{ href: requirementDetailPath(questionId), label: '要求事項の評価へ戻る' }}
    />
  );
}
