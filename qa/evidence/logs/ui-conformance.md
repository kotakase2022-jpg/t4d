# UI コントロール実在確認（実ブラウザ）

| 要件ID        | 確認項目           | 実在     | セレクタと件数                                                                         |
| ------------- | ------------------ | -------- | -------------------------------------------------------------------------------------- |
| UX-P0-004     | 列表示切替         | **無し** | [button:has-text("列"), [data-t4d-column-selector]] count=0                            |
| UX-P0-004     | 並べ替え           | **無し** | [th button, th a, [aria-sort], [data-sort]] count=0                                    |
| UX-P0-004     | 固定列/Sticky      | 有り     | [.sticky, [class*="sticky"]] count=1                                                   |
| UX-P0-004     | 複合フィルター     | 有り     | [[data-t4d-list-search]] count=1                                                       |
| UX-P0-004     | 一括選択           | 有り     | [input[name="selected"]] count=25                                                      |
| UX-P0-004     | 保存ビュー         | 有り     | [a:has-text("要対応のみ")] count=1                                                     |
| UX-P0-004     | CSV出力            | 有り     | [a[href*="/api/exports/data-points"]] count=2                                          |
| EVID-P0-002   | 画面内ビューア     | **無し** | [iframe, embed, object, canvas, img[src*="evidence"]] count=0                          |
| EVID-P0-002   | 該当箇所ハイライト | **無し** | [mark, [data-highlight]] count=0                                                       |
| DATA-P0-004   | 前年度複製         | **無し** | [button:has-text("前年"), button:has-text("複製")] count=0                             |
| ORG-P0-001    | 組織の登録・編集UI | **無し** | [form button[type="submit"], button:has-text("追加"), button:has-text("編集")] count=0 |
| MASTER-P0-001 | 指標マスター管理UI | **無し** | [a[href*="metric"], button:has-text("指標")] count=0                                   |
| AUTH-P0-001   | ユーザー招待UI     | **無し** | [button:has-text("招待"), a:has-text("招待")] count=0                                  |
| AI-P0-001     | 対話入力欄         | **無し** | [textarea, input[type="text"][placeholder*="質問"]] count=0                            |
| CDP-P0-002    | 適用判定表示       | **無し** | [:text("適用"), :text("非適用"), :text("要確認")] count=0                              |
| CDP-P0-003    | 過去回答Import     | **無し** | [input[type="file"], button:has-text("取込")] count=0                                  |
| CDP-P0-006    | 整合チェック実行   | **無し** | [button:has-text("チェック"), button:has-text("整合")] count=0                         |
| WF-P0-002     | メンション         | **無し** | [[data-mention], :text("@")] count=0                                                   |
| ASSUR-P0-009  | 三ペイン           | **無し** | [.grid-cols-3, [class*="grid-cols-3"]] count=0                                         |
| ASSUR-P0-008  | 再計算入力         | 有り     | [input[name*="recalc"], :text("再計算")] count=5                                       |
