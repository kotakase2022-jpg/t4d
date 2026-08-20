import '@testing-library/jest-dom/vitest';

// 表示は常に Asia/Tokyo 前提（指示書 21 章）。テスト環境も固定する。
process.env.TZ = 'Asia/Tokyo';
process.env.NEXT_PUBLIC_APP_MODE = 'demo';

// テストは決定論的な MockAIProvider だけを使う。
// 実行環境に OPENAI_API_KEY があっても、テストから課金 API を叩かせない。
process.env.OPENAI_API_KEY = '';
