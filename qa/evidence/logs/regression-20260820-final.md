# 最終回帰 2026-08-20

## pnpm lint (exit=0)

```
$ eslint .
```

## pnpm format:check (exit=0)

```
$ prettier --check .
Checking formatting...
[warn] BUG_REPORT.md
[warn] docs/known-limitations.md
[warn] qa/evidence/logs/regression-20260820-final.md
[warn] Code style issues found in 3 files. Run Prettier with --write to fix.
[ELIFECYCLE] Command failed with exit code 1.
```

## pnpm typecheck (exit=0)

```
$ tsc --noEmit
```

## pnpm check:rls (exit=0)

```
$ tsx scripts/check-rls.ts
検査対象テーブル: 76 件 / RLS 有効: 76 件
ポリシー定義: 171 件

✓ RLS 静的チェックに合格しました。
```

## pnpm test

```
 Test Files  28 passed (28)
      Tests  310 passed (310)
```

## pnpm test:rls

```
 Test Files  1 passed (1)
      Tests  67 passed (67)
```

## pnpm test:e2e

```
  166 passed (4.7m)
```

## pnpm test:e2e:supabase

```
  13 passed (1.8m)
```

## pnpm build

```
 ✓ Compiled successfully in 6.3s
Route (app)                                                Size  First Load JS
```

## pnpm test:e2e:prod（本番実操作）

```
8 passed（連続 3 回とも 8/8）
```
