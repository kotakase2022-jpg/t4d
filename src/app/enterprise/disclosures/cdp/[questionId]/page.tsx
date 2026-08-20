import { QuestionDetailView } from '../../question-view';

export const metadata = { title: 'CDP 質問' };

export default async function CdpQuestionPage({
  params,
}: {
  params: Promise<{ questionId: string }>;
}) {
  const { questionId } = await params;
  return (
    <QuestionDetailView
      frameworkKey="cdp"
      frameworkLabel="CDP"
      basePath="/enterprise/disclosures/cdp"
      questionId={questionId}
    />
  );
}
