import { createPinyinEngine } from './vendor/pinyin-engine';
import { dict } from 'pinyin-ime/dictionary/google_pinyin_dict';

// The dictionary and indexes live only in this worker, never on the drawing thread.
const engine = createPinyinEngine(dict);
self.onmessage = (event: MessageEvent<{ id: number; input: string }>) => {
  const { id, input } = event.data;
  if (input.length > 48 || !/^[a-z']*$/.test(input)) return;
  const normalized = input.replace(/'/g, '');
  const boundaries = input
    .split("'")
    .filter(Boolean)
    .map((part) => part.length);
  const candidates = engine
    .getCandidates(input)
    .candidates.filter((item) => {
      if (!input.includes("'")) return true;
      // Respect an explicit xi'an boundary; do not rank a one-syllable xian
      // character above the requested two-syllable phrase.
      let length = 0,
        syllables = 0;
      for (const size of boundaries) {
        if (length >= item.matchedLength) break;
        length += size;
        syllables++;
      }
      return Array.from(item.word).length >= syllables;
    })
    .map((item) => {
      // Upstream lengths count letters, so map back over syllable separators.
      const count = Math.min(normalized.length, item.matchedLength);
      let consumed = 0,
        letters = 0;
      while (consumed < input.length && letters < count) {
        if (input[consumed] !== "'") letters++;
        consumed++;
      }
      while (input[consumed] === "'") consumed++;
      return { word: item.word, matchedLength: consumed };
    });
  self.postMessage({ id, input, candidates });
};
self.postMessage({ ready: true });
