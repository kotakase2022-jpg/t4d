/** scripts/codemod-tokens.mjs の型（tests/unit/design-tokens.test.ts が読む） */
export interface TokenReplacement {
  from: string;
  to: string;
  token: string;
  value: string;
  prefix?: boolean;
  files?: string[];
}

export const TOKEN_REPLACEMENTS: TokenReplacement[];
export const BUTTON_VARIANT_RENAMES: Record<string, string>;

export function replaceTokens(
  source: string,
  file: string,
): { source: string; counts: Record<string, number> };

export function transformButtons(source: string): {
  source: string;
  added: number;
  renamed: number;
  dynamic: number[];
};
