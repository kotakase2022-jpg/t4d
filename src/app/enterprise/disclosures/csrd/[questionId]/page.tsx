import { QuestionDetailView } from '../../question-view';

export const metadata = { title: 'CSRD 開示項目' };

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
    />
  );
}
