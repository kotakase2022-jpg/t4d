import type { CsrdDmaIro, ImpactDirection, ImpactOccurrence, IroType } from '@/types/domain';

/**
 * IRO フォームの初期値（docs/disclosure-first.md §9.2）。Server Component（事項の画面）と
 * Client Component（IroForm）の両方が使うため、'use client' の外に置く。
 * 数値の欄は select の値（文字列）で持ち、未入力は空文字（0 にしない）。
 */
export interface IroFormValues {
  iroId: string | null;
  iroType: IroType;
  subTopic: string;
  description: string;
  valueChainStage: string;
  timeHorizon: string;
  impactOccurrence: ImpactOccurrence | '';
  impactDirection: ImpactDirection | '';
  impactScale: string;
  impactScope: string;
  impactIrremediability: string;
  impactLikelihood: string;
  financialLikelihood: string;
  financialMagnitude: string;
  humanRights: boolean;
  affectedStakeholders: string;
  relatedImpactIroId: string;
}

/** 追加のときの初期値（よく使う「実在・負のインパクト」） */
export const EMPTY_IRO_FORM: IroFormValues = {
  iroId: null,
  iroType: 'impact',
  subTopic: '',
  description: '',
  valueChainStage: 'own_operations',
  timeHorizon: '',
  impactOccurrence: 'actual',
  impactDirection: 'negative',
  impactScale: '',
  impactScope: '',
  impactIrremediability: '',
  impactLikelihood: '',
  financialLikelihood: '',
  financialMagnitude: '',
  humanRights: false,
  affectedStakeholders: '',
  relatedImpactIroId: '',
};

const str = (value: number | string | null): string => (value === null ? '' : String(value));

/** 保存済みの IRO を、編集フォームの初期値にする */
export function iroFormValuesOf(iro: CsrdDmaIro): IroFormValues {
  return {
    iroId: iro.id,
    iroType: iro.iroType,
    subTopic: iro.subTopic,
    description: iro.description,
    valueChainStage: iro.valueChainStage,
    timeHorizon: str(iro.timeHorizon),
    impactOccurrence: iro.impactOccurrence ?? '',
    impactDirection: iro.impactDirection ?? '',
    impactScale: str(iro.impactScale),
    impactScope: str(iro.impactScope),
    impactIrremediability: str(iro.impactIrremediability),
    impactLikelihood: str(iro.impactLikelihood),
    financialLikelihood: str(iro.financialLikelihood),
    financialMagnitude: str(iro.financialMagnitude),
    humanRights: iro.humanRights,
    affectedStakeholders: iro.affectedStakeholders,
    relatedImpactIroId: iro.relatedImpactIroId ?? '',
  };
}
