import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';

/**
 * Flat Config を直接組み立てる。
 * `eslint-config-next` は eslintrc 形式のため FlatCompat 経由となり、
 * @next/eslint-plugin-next のバージョン差でスキーマ検証に失敗する。
 * 必要なプラグインを明示的に読み込む方が壊れにくい。
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
      'supabase/**',
      // git 管理外のローカル作業フォルダ（.gitignore と対）。lint の対象にしない
      'local-evidence/**',
      '*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        requestAnimationFrame: 'readonly',
        structuredClone: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        crypto: 'readonly',
        KeyboardEvent: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLTableElement: 'readonly',
        HTMLTableRowElement: 'readonly',
        HTMLTableCellElement: 'readonly',
        HTMLTableSectionElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLHeadingElement: 'readonly',
        HTMLParagraphElement: 'readonly',
        HTMLSpanElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLLabelElement: 'readonly',
        Event: 'readonly',
        __dirname: 'readonly',
        module: 'readonly',
        require: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: {
      '@next/next': nextPlugin,
      react: reactPlugin,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactPlugin.configs.flat.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Input / Textarea は独自プリミティブのため、静的解析へ「これは control である」と教える
      'jsx-a11y/label-has-associated-control': [
        'error',
        {
          controlComponents: [
            'Input',
            'Textarea',
            'SelectTrigger',
            'Checkbox',
            'NativeSelect',
            'NativeCheckbox',
          ],
          depth: 5,
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-undef': 'off',
    },
  },
  {
    // Node スクリプト / テストでは console を許容
    files: ['scripts/**/*.{ts,mjs}', 'tests/**/*.{ts,tsx}', '*.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    /**
     * デザイントークンと共通部品の再発防止（docs/ui-redesign/plan.md §3.4-3・§5.4 Consistency）。
     * Stage C で件数を 0 にした項目だけをエラーにする（数え方は scripts/ui-metrics-core.ts と同じ。
     * 0 にできていない項目は tests/unit/ui-ratchet.test.ts の段階的上限で増やさない）。
     * 部品の定義そのもの（src/components/ui の各部品・EmptyState）は除く。
     */
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/components/ui/button.tsx',
      'src/components/ui/submit-button.tsx',
      'src/components/ui/icon-button.tsx',
      'src/components/ui/collapsible.tsx',
      'src/components/ui/more-info.tsx',
      'src/components/ui/form-section.tsx',
      'src/components/ui/native-select.tsx',
      'src/components/ui/native-checkbox.tsx',
      'src/components/shared/states.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/(^|[\\s:!])text-\\[\\d+(\\.\\d+)?px\\]/]',
          message:
            '文字サイズは globals.css のトークン（text-caption・text-small・text-body・text-title など）を使ってください（plan §3.3）。',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|[\\s:!])text-\\[\\d+(\\.\\d+)?px\\]/]',
          message:
            '文字サイズは globals.css のトークン（text-caption・text-small・text-body・text-title など）を使ってください（plan §3.3）。',
        },
        {
          selector: 'Literal[value=/[a-z-]+-\\[#[0-9a-fA-F]{3,8}\\]/]',
          message:
            '色は globals.css のトークン（brand-*・ink・warning-ink など）を使ってください（plan §3.3）。',
        },
        {
          selector: 'TemplateElement[value.raw=/[a-z-]+-\\[#[0-9a-fA-F]{3,8}\\]/]',
          message:
            '色は globals.css のトークン（brand-*・ink・warning-ink など）を使ってください（plan §3.3）。',
        },
        {
          selector: 'Literal[value=/(^|[\\s:!])-?z-(\\d+|\\[\\d+\\])($|\\s)/]',
          message:
            '重なりの順は役割のトークン（z-(--z-sticky)・z-(--z-modal)・z-(--z-popover) など）を使ってください（plan §3.3）。',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|[\\s:!])-?z-(\\d+|\\[\\d+\\])($|\\s)/]',
          message:
            '重なりの順は役割のトークン（z-(--z-sticky)・z-(--z-modal)・z-(--z-popover) など）を使ってください（plan §3.3）。',
        },
        {
          selector: 'Literal[value=/(^|[\\s:!])shadow-(sm|md|lg|xl|2xl|\\[)/]',
          message: '影は shadow-raised・shadow-overlay を使ってください（plan §3.3）。',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|[\\s:!])shadow-(sm|md|lg|xl|2xl|\\[)/]',
          message: '影は shadow-raised・shadow-overlay を使ってください（plan §3.3）。',
        },
        {
          selector: 'Literal[value=/(^|[\\s:!])rounded-(sm|md|lg|xl)($|\\s)/]',
          message:
            '角丸は rounded-t4d-sm・rounded-t4d・rounded-t4d-lg を使ってください（plan §3.3）。',
        },
        {
          selector: 'TemplateElement[value.raw=/(^|[\\s:!])rounded-(sm|md|lg|xl)($|\\s)/]',
          message:
            '角丸は rounded-t4d-sm・rounded-t4d・rounded-t4d-lg を使ってください（plan §3.3）。',
        },
        {
          selector:
            "JSXOpeningElement[name.name=/^(Button|SubmitButton)$/] > JSXAttribute[name.name='variant'][value.value='outline']",
          message: 'variant="outline" は廃止しました。secondary を使ってください（plan §3.1）。',
        },
        {
          selector: "JSXOpeningElement[name.name='details']",
          message:
            '素の <details> ではなく Collapsible・MoreInfo・FormSection・Section collapsible を使ってください（plan §3.1）。',
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: '素の <select> ではなく NativeSelect を使ってください（plan §1.13-6）。',
        },
        {
          selector:
            "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='checkbox']",
          message: '素の checkbox ではなく NativeCheckbox を使ってください（plan §1.13-6）。',
        },
        {
          selector:
            "JSXOpeningElement[name.name='Button'] > JSXAttribute[name.name='type'][value.value='submit']",
          message: '送信ボタンは SubmitButton を使ってください（送信中の表示。plan §1.13-5）。',
        },
        {
          selector: "CallExpression[callee.name='buttonVariants']",
          message: 'buttonVariants を直接使わず、Button（asChild）を使ってください（plan §3.1）。',
        },
        {
          selector:
            "JSXOpeningElement[name.name='EmptyState']:not(:has(JSXAttribute[name.name='kind']))",
          message:
            'EmptyState には kind（no-data・filtered・not-applicable・done）を付けてください（plan §1.18）。',
        },
      ],
    },
  },
  prettier,
);
