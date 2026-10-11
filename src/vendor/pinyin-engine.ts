// Vendored from pinyin-ime 1.0.2 (MIT). See docs/PINYIN-NOTICES.md.
// Adapted: inline dictionary type, bounded prefix cache; UI/DOM parts excluded.
/**
 * @file pinyin-engine.ts
 * @description 可注入字典的拼音匹配引擎（`createPinyinEngine`）。
 */

type PinyinDict = Record<string, Array<{w: string; f: number}>>;

/**
 * 单字母前缀递进（ztai → z）时合并词条数上限，避免与「全字典 z*」等长列表拖慢 UI。
 *
 * @remarks
 * 与单独输入 `z` 时逻辑一致，但长串下只取高频前若干条。
 */
const SINGLE_LETTER_PREFIX_CAP = 200;
/** 候选返回上限：限制排序与渲染压力，保障长串输入稳定性。 */
const MAX_CANDIDATE_COUNT = 300;
/** 短输入（1-2 键）时启用单字增强。 */
const SHORT_INPUT_SINGLE_CHAR_BOOST_MAX_LEN = 2;
/** 单字增强分值：仅在短输入下参与排序加权。 */
const SHORT_INPUT_SINGLE_CHAR_BOOST_SCORE = 50_000;
/** 前排单字保底席位数量（仅短输入）。 */
const SHORT_INPUT_SINGLE_CHAR_FLOOR = 2;
/** 短输入前排观察窗口：在该范围内保证单字席位。 */
const SHORT_INPUT_SINGLE_CHAR_FLOOR_WINDOW = 10;
/** 插入单字的起始位置（保留最前若干位给强匹配候选）。 */
const SHORT_INPUT_SINGLE_CHAR_INSERT_AT = 2;
/** 触发前缀补充召回的最小输入长度。 */
const PREFIX_EXPANSION_MIN_INPUT_LEN = 2;

/** 单个候选词及其消耗的拼音长度 */
export interface CandidateItem {
  /** 候选词 */
  word: string;
  /** 本候选消耗的拼音长度，选词后剩余 = pinyin.slice(matchedLength) */
  matchedLength: number;
}

/** 候选词列表（每项含匹配长度） */
export interface PinyinMatchResult {
  candidates: CandidateItem[];
}

interface WordFreq {
  w: string;
  f: number;
}

/**
 * 拼音 key 前缀索引节点。
 */
interface PinyinKeyTrieNode {
  children: Map<string, PinyinKeyTrieNode>;
  /** 当前前缀下所有完整 key。 */
  keysUnderPrefix: string[];
}

/**
 * 由 {@link createPinyinEngine} 返回的匹配 API。
 */
export interface PinyinEngine {
  /**
   * 根据拼音输入获取候选词列表。
   *
   * @param input - 拼音字符串（小写，可含单引号分隔）
   * @returns 匹配结果，每项含 word 与 matchedLength
   */
  getCandidates(input: string): PinyinMatchResult;

  /**
   * 选词后从输入中应消去的长度（反向拼音匹配）。
   *
   * @param word - 选中的词
   * @param input - 当前拼音输入
   * @param fallback - 无匹配时的回退长度
   * @returns 应消去的长度
   */
  computeMatchedLength(word: string, input: string, fallback: number): number;
}

/**
 * 构建「词 → 全局最高频」映射，供候选同层排序。
 *
 * @param dict - 拼音词典
 * @returns 词频映射
 */
function buildWordMaxFreqByWord(
  dict: Record<string, WordFreq[] | undefined>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const key in dict) {
    const list = dict[key];
    if (!list) continue;
    for (const item of list) {
      const prev = map.get(item.w);
      if (prev === undefined || item.f > prev) map.set(item.w, item.f);
    }
  }
  return map;
}

/**
 * 构建「词 -> 所有拼音 key」索引，避免反向匹配时重复全量遍历词典。
 *
 * @param dict - 拼音词典
 * @returns 词到 key 列表的映射
 */
function buildWordKeysIndex(
  dict: Record<string, WordFreq[] | undefined>
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const key in dict) {
    const list = dict[key];
    if (!list) continue;
    for (const item of list) {
      const keys = index.get(item.w);
      if (keys) {
        keys.push(key);
      } else {
        index.set(item.w, [key]);
      }
    }
  }
  return index;
}

/**
 * 创建空 Trie 节点。
 *
 * @returns 新节点
 */
function createPinyinKeyTrieNode(): PinyinKeyTrieNode {
  return { children: new Map<string, PinyinKeyTrieNode>(), keysUnderPrefix: [] };
}

/**
 * 基于词典 key 构建前缀 Trie 索引。
 *
 * @param dict - 拼音词典
 * @returns 根节点
 */
function buildPinyinKeyTrie(
  dict: Record<string, WordFreq[] | undefined>
): PinyinKeyTrieNode {
  const root = createPinyinKeyTrieNode();
  for (const key in dict) {
    if (!dict[key]) continue;
    let node = root;
    node.keysUnderPrefix.push(key);
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = createPinyinKeyTrieNode();
        node.children.set(ch, next);
      }
      node = next;
      node.keysUnderPrefix.push(key);
    }
  }
  return root;
}

/**
 * 读取 Trie 中某前缀下的所有 key。
 *
 * @param root - Trie 根节点
 * @param prefix - 拼音前缀
 * @returns 命中的 key 列表
 */
function getKeysByPrefix(
  root: PinyinKeyTrieNode,
  prefix: string
): readonly string[] {
  let node: PinyinKeyTrieNode | undefined = root;
  for (const ch of prefix) {
    node = node.children.get(ch);
    if (!node) return [];
  }
  return node.keysUnderPrefix;
}

/** 同一 {@link PinyinDict} 对象引用复用引擎，避免多实例重复建索引。 */
const pinyinEngineByDict = new WeakMap<PinyinDict, PinyinEngine>();

/**
 * 基于给定词典构建拼音引擎（不查缓存；由 {@link createPinyinEngine} 内部调用）。
 *
 * @param dict - 与 {@link PinyinDict} 同形的记录表
 * @returns `getCandidates` 与 `computeMatchedLength`
 */
function createPinyinEngineUncached(dict: PinyinDict): PinyinEngine {
  const d = dict as Record<string, WordFreq[] | undefined>;
  const wordMaxFreqByWord = buildWordMaxFreqByWord(d);
  const wordKeysIndex = buildWordKeysIndex(d);
  const keyTrieRoot = buildPinyinKeyTrie(d);
  const prefixWordsCache = new Map<string, WordFreq[]>();

  const syllableSet = new Set(
    Object.keys(d).filter(
      (k) => /^[a-z]{1,6}$/.test(k) && /[aeiouv]/.test(k)
    )
  );

  function mergeAndSort(groups: Array<WordFreq[]>): WordFreq[] {
    const map = new Map<string, number>();
    for (const group of groups) {
      for (const item of group) {
        const existing = map.get(item.w);
        if (existing === undefined || item.f > existing) {
          map.set(item.w, item.f);
        }
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([w, f]) => ({ w, f }));
  }

  function collectWordsForPrefixKey(prefix: string): WordFreq[] {
    const cached = prefixWordsCache.get(prefix);
    if (cached) return cached;

    const fullGroups: WordFreq[][] = [];
    const exactMatch = d[prefix];
    if (exactMatch) {
      fullGroups.push(exactMatch);
    } else {
      const prefixKeys = getKeysByPrefix(keyTrieRoot, prefix);
      for (const key of prefixKeys) {
        const val = d[key];
        if (val) fullGroups.push(val);
      }
    }
    const merged = mergeAndSort(fullGroups);
    if (prefixWordsCache.size >= 96) prefixWordsCache.delete(prefixWordsCache.keys().next().value!);
    prefixWordsCache.set(prefix, merged);
    return merged;
  }

  function getWordKeys(word: string): string[] {
    return wordKeysIndex.get(word) ?? [];
  }

  function splitToSyllables(key: string): string[] | null {
    const memo = new Map<number, string[] | null>();

    const dfs = (start: number): string[] | null => {
      if (start === key.length) return [];
      const cached = memo.get(start);
      if (cached !== undefined) return cached;

      for (let end = Math.min(key.length, start + 6); end > start; end--) {
        const seg = key.substring(start, end);
        if (!syllableSet.has(seg)) continue;
        const rest = dfs(end);
        if (rest) {
          const result = [seg, ...rest];
          memo.set(start, result);
          return result;
        }
      }
      memo.set(start, null);
      return null;
    };

    return dfs(0);
  }

  function matchMixedConsumedLength(input: string, key: string): number {
    if (input.startsWith(key)) return key.length;

    const syllables = splitToSyllables(key);
    if (!syllables) return 0;

    let best = 0;
    const dfs = (idx: number, pos: number): void => {
      if (pos > best) best = pos;
      if (idx >= syllables.length || pos >= input.length) return;

      const syl = syllables[idx];
      if (input.startsWith(syl, pos)) {
        dfs(idx + 1, pos + syl.length);
      }
      if (input[pos] === syl[0]) {
        dfs(idx + 1, pos + 1);
      }
    };

    dfs(0, 0);
    return best;
  }

  /**
   * 计算「输入前缀」在 key 上可匹配的最长子序列长度（顺序一致、可跳过 key 中字符）。
   *
   * @remarks
   * 这是一种更宽松的混拼回退策略：当音节切分无法覆盖某些简拼组合时，
   * 仍可按顺序匹配（例如 `tqi` 对 `tianqi` 可得到 3）。
   *
   * @param input - 用户拼音输入（已归一化）
   * @param key - 词条拼音 key
   * @returns 可消去的输入长度
   */
  function matchSubsequenceConsumedLength(input: string, key: string): number {
    if (!input || !key) return 0;
    let consumed = 0;
    let keyPos = 0;
    while (consumed < input.length && keyPos < key.length) {
      const ch = input[consumed];
      while (keyPos < key.length && key[keyPos] !== ch) {
        keyPos += 1;
      }
      if (keyPos >= key.length) break;
      consumed += 1;
      keyPos += 1;
    }
    return consumed;
  }

  function upsertCandidate(
    list: CandidateItem[],
    indexMap: Map<string, number>,
    word: string,
    matchedLength: number
  ): void {
    const idx = indexMap.get(word);
    if (idx === undefined) {
      indexMap.set(word, list.length);
      list.push({ word, matchedLength });
      return;
    }
    if (matchedLength > list[idx].matchedLength) {
      list[idx] = { ...list[idx], matchedLength };
    }
  }

  function getWordMaxFreq(word: string): number {
    return wordMaxFreqByWord.get(word) ?? 0;
  }

  /**
   * 按「匹配长度优先，其次频率」排序；短输入时对单字做轻量增强。
   *
   * @param items - 候选列表
   * @param inputLen - 输入长度
   * @returns 排序并截断后的候选
   */
  function sortCandidatesByMatchThenFreq(
    items: CandidateItem[],
    inputLen: number
  ): CandidateItem[] {
    const isShortInput = inputLen <= SHORT_INPUT_SINGLE_CHAR_BOOST_MAX_LEN;
    const getScore = (item: CandidateItem): number => {
      let score = getWordMaxFreq(item.word);
      if (isShortInput && item.word.length === 1) {
        score += SHORT_INPUT_SINGLE_CHAR_BOOST_SCORE;
      }
      return score;
    };
    const sorted = [...items].sort((a, b) => {
      if (b.matchedLength !== a.matchedLength) {
        return b.matchedLength - a.matchedLength;
      }
      return getScore(b) - getScore(a);
    });
    return sorted;
  }

  /**
   * 短输入场景下保障前排有最少单字席位，改善首屏可选性。
   *
   * @param items - 已排序候选
   * @param inputLen - 输入长度
   * @returns 应用单字席位策略后的候选
   */
  function applyShortInputSingleCharFloor(
    items: CandidateItem[],
    inputLen: number
  ): CandidateItem[] {
    if (inputLen > SHORT_INPUT_SINGLE_CHAR_BOOST_MAX_LEN) return items;
    if (items.length === 0) return items;

    const top = items.slice(
      0,
      Math.min(items.length, SHORT_INPUT_SINGLE_CHAR_FLOOR_WINDOW)
    );
    const existingSingleCount = top.filter((it) => it.word.length === 1).length;
    if (existingSingleCount >= SHORT_INPUT_SINGLE_CHAR_FLOOR) return items;

    const missing = SHORT_INPUT_SINGLE_CHAR_FLOOR - existingSingleCount;
    const promote = items
      .slice(top.length)
      .filter((it) => it.word.length === 1)
      .slice(0, missing);
    if (promote.length === 0) return items;

    const result = [...items];
    for (const p of promote) {
      const idx = result.indexOf(p);
      if (idx >= 0) result.splice(idx, 1);
    }
    const insertAt = Math.min(
      result.length,
      Math.max(SHORT_INPUT_SINGLE_CHAR_INSERT_AT, existingSingleCount)
    );
    result.splice(insertAt, 0, ...promote);
    return result;
  }

  function computeMatchedLength(
    word: string,
    input: string,
    fallback: number
  ): number {
    const normalized = input.toLowerCase().replace(/'/g, "");
    if (!normalized) return 0;

    let maxLen = fallback;
    const keys = getWordKeys(word);
    for (const key of keys) {
      const consumed = Math.max(
        matchMixedConsumedLength(normalized, key),
        matchSubsequenceConsumedLength(normalized, key)
      );
      if (consumed > maxLen) maxLen = consumed;
    }
    return maxLen;
  }

  function getCandidates(input: string): PinyinMatchResult {
    if (!input) return { candidates: [] };

    const normalized = input.toLowerCase().replace(/'/g, "");

    const result: CandidateItem[] = [];
    const indexMap = new Map<string, number>();

    const fullWords = collectWordsForPrefixKey(normalized);
    for (const { w } of fullWords) {
      upsertCandidate(result, indexMap, w, normalized.length);
    }

    if (normalized.length >= PREFIX_EXPANSION_MIN_INPUT_LEN) {
      for (let sylLen = 1; sylLen < normalized.length; sylLen++) {
        const syl = normalized.substring(0, sylLen);
        let sylWords = collectWordsForPrefixKey(syl);
        if (
          sylLen === 1 &&
          normalized.length > sylLen &&
          sylWords.length > SINGLE_LETTER_PREFIX_CAP
        ) {
          sylWords = sylWords.slice(0, SINGLE_LETTER_PREFIX_CAP);
        }
        for (const { w } of sylWords) {
          upsertCandidate(result, indexMap, w, sylLen);
        }
      }
    }

    if (result.length === 0) {
      for (let len = normalized.length - 1; len >= 1; len--) {
        const prefix = normalized.substring(0, len);
        const fallbackWords = collectWordsForPrefixKey(prefix);

        if (fallbackWords.length > 0) {
          for (const { w } of fallbackWords) {
            upsertCandidate(result, indexMap, w, len);
          }
          break;
        }
      }
    }

    const sorted = sortCandidatesByMatchThenFreq(result, normalized.length);
    const floored = applyShortInputSingleCharFloor(sorted, normalized.length);
    if (floored.length <= MAX_CANDIDATE_COUNT) {
      return { candidates: floored };
    }
    return { candidates: floored.slice(0, MAX_CANDIDATE_COUNT) };
  }

  return { getCandidates, computeMatchedLength };
}

/**
 * 基于给定词典创建拼音引擎；**同一 `dict` 对象引用**返回同一实例，共享前缀缓存与索引。
 *
 * @param dict - 与 {@link PinyinDict} 同形的记录表；传入后请勿再修改其内容。
 * @returns `getCandidates` 与 `computeMatchedLength`
 */
export function createPinyinEngine(dict: PinyinDict): PinyinEngine {
  const hit = pinyinEngineByDict.get(dict);
  if (hit) return hit;
  const engine = createPinyinEngineUncached(dict);
  pinyinEngineByDict.set(dict, engine);
  return engine;
}
