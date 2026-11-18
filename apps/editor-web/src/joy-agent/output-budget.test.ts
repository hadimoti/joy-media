import { describe, expect, it } from 'vitest';
import { outputTokenBudget } from './output-budget.js';

describe('outputTokenBudget', () => {
  it.each([
    'https://api.minimax.io/v1',
    'https://api.minimax.io/anthropic',
    'https://api.minimaxi.com/v1',
    'https://sub.api.minimaxi.com/v1',
    'https://API.MINIMAX.IO/v1',
  ])('gives a thinking-model budget to MiniMax host %s', (baseUrl) => {
    expect(outputTokenBudget({ baseUrl })).toBe(16384);
  });

  it.each([
    'https://minimax.io.evil.example/v1',
    'https://evilminimax.io/v1',
    'https://api.minimax.io.evil.example/v1',
    'https://minimaxi.com.evil.example/v1',
    'https://api.moonshot.ai/v1',
    'https://api.openai.com/v1',
    'https://api.kimi.ai/coding/v1',
  ])('keeps the 2,048 default for %s', (baseUrl) => {
    expect(outputTokenBudget({ baseUrl })).toBe(2048);
  });

  it('keeps the default when the base URL is not a URL', () => {
    expect(outputTokenBudget({ baseUrl: '' })).toBe(2048);
    expect(outputTokenBudget({ baseUrl: 'not a url' })).toBe(2048);
  });
});
