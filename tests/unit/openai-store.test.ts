// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * OpenAI の Responses API に、提供元での保存（store）を明示して渡す（トライアル対応 NF-28）。
 * 既定は保存しない（plan §5 D16 の既定）。OPENAI_STORE=true のときだけ保存させる。
 * 実際の API は呼ばない（SDK を差し替え、渡した引数だけを確かめる）。
 */

const parse = vi.fn();

vi.mock('openai', () => ({
  default: class {
    responses = { parse };
  },
}));
vi.mock('openai/helpers/zod', () => ({
  zodTextFormat: () => ({ type: 'json_schema' }),
}));

const OUTPUT = {
  mappings: [],
  confidence: 0.5,
  warnings: [],
  sources: [],
};

async function runOnce() {
  parse.mockResolvedValueOnce({
    output_parsed: OUTPUT,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  vi.resetModules();
  const { OpenAIProvider } = await import('@/lib/ai/openai-provider');
  const provider = new OpenAIProvider();
  await provider.run({
    feature: 'cdpQuestionMapping',
    context: { organizationName: 'テスト（架空）', reportingPeriodLabel: 'FY2026' },
    inputReferenceIds: [],
    input: { items: [] },
  });
  return parse.mock.calls.at(-1)![0] as { store?: unknown };
}

afterEach(() => {
  vi.unstubAllEnvs();
  parse.mockReset();
});

describe('OpenAIProvider の store', () => {
  it('既定は保存しない（store: false を明示する）', async () => {
    // テスト用の値（実在のキーではない。SDK は差し替えてあり外へ送らない）
    vi.stubEnv('OPENAI_API_KEY', 'test-placeholder');
    vi.stubEnv('OPENAI_STORE', '');
    const params = await runOnce();
    expect(params.store).toBe(false);
  });

  it('OPENAI_STORE=true のときだけ保存させる', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-placeholder');
    vi.stubEnv('OPENAI_STORE', 'true');
    const params = await runOnce();
    expect(params.store).toBe(true);
  });
});
