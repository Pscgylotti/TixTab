import { describe, expect, it } from 'vitest';
import { createPinyinEngine } from './vendor/pinyin-engine';
import { dict } from 'pinyin-ime/dictionary/google_pinyin_dict';
const engine = createPinyinEngine(dict);
describe('bundled offline Pinyin dictionary', () => {
  it('returns ranked everyday phrases and syllable-separated words', () => {
    for (const [input, word] of [
      ['nihao', '你好'],
      ['zhongguo', '中国'],
      ["xi'an", '西安'],
      ['gongshi', '公式'],
    ]) {
      const candidates = engine.getCandidates(input).candidates;
      expect(candidates.slice(0, 10).map((c) => c.word)).toContain(word);
      expect(candidates.find((c) => c.word === word)?.matchedLength).toBe(
        input.replace(/'/g, '').length,
      );
    }
  });
  it('keeps candidates bounded for long input and supports choosing a partial phrase', () => {
    const results = engine.getCandidates('nihaozhongguo').candidates;
    const candidate = results.find((c) => c.word === '你好');
    expect(candidate?.matchedLength).toBe(5);
    expect(results.length).toBeLessThanOrEqual(300);
    expect(engine.getCandidates('')).toEqual({ candidates: [] });
  });
});
