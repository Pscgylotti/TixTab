import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import english from './locales/en.json';
import { setLocale, t } from './i18n';

const han = /\p{Script=Han}/u;
const dictionary: Record<string, string> = english;
const patterns = Object.keys(dictionary)
  .filter((key) => han.test(key) && /\{\d+\}/.test(key))
  .map(
    (key) =>
      new RegExp(
        '^' +
          key
            .split(/\{\d+\}/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('[\\s\\S]*?') +
          '$',
      ),
  );
const covered = (key: string) =>
  Object.hasOwn(dictionary, key) || patterns.some((p) => p.test(key));

it('covers static translated UI strings without treating placeholder-only patterns as translations', () => {
  const missing: string[] = [];
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'locales') scan(path);
        continue;
      }
      if (!/\.tsx?$/.test(path) || /\.(test|d)\.ts$/.test(path)) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      function check(node: ts.Node) {
        let key: string | undefined;
        if (ts.isStringLiteralLike(node)) key = node.text;
        else if (ts.isTemplateExpression(node))
          key =
            node.head.text + node.templateSpans.map((s, i) => `{${i}}${s.literal.text}`).join('');
        if (key !== undefined) {
          if (han.test(key) && !covered(key))
            missing.push(
              `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${key}`,
            );
          return;
        }
        ts.forEachChild(node, check);
      }
      function walk(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ['t', 'tr'].includes(node.expression.text) &&
          node.arguments[0]
        )
          check(node.arguments[0]);
        ts.forEachChild(node, walk);
      }
      walk(source);
    }
  }
  scan('src');
  expect(missing).toEqual([]);
});

it('translates draft controls and dynamic statuses while preserving supplied content', () => {
  try {
    setLocale('en');
    expect(t('草稿纸')).toBe('Draft');
    expect(t('草稿纸{0}', 3)).toBe('Draft 3');
    expect(t('已完成 {0} 项，未识别 {1} 项。', 12, 2)).toBe(
      'Completed 12 items; 2 items were not recognized.',
    );
    expect(t('已完成 12 项，未识别 2 项。')).toBe(
      'Completed 12 items; 2 items were not recognized.',
    );
    expect(t('选择{0}', '我的计算')).toBe('Select 我的计算');
    expect(t('我的自定义标题')).toBe('我的自定义标题');
    setLocale('zh-CN');
    expect(t('Completed 12 items; 2 items were not recognized.')).toBe(
      '已完成 12 项，未识别 2 项。',
    );
  } finally {
    setLocale('zh-CN');
  }
});
