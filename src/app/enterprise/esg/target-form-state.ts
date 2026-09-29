/** 目標登録フォームの状態（Server Action と Client Component で共有する） */
export interface KpiTargetFormState {
  /** 送信の回数。失敗したときにフォームを入力値付きで作り直すための key に使う */
  attempt: number;
  message: string | null;
  /** 失敗したときの入力値（入力を失わせない） */
  values: Record<string, string>;
}

export const INITIAL_KPI_TARGET_FORM_STATE: KpiTargetFormState = {
  attempt: 0,
  message: null,
  values: {},
};
