import test from 'node:test'
import assert from 'node:assert/strict'
import { extractFileReferences } from '../index.js'

test('extracts Markdown links, backticked paths, and bare paths', () => {
  const text = [
    '成品在 [v4-paper-voice.mp4](color-secrets-class/out/v4-paper-voice.mp4)，',
    '对比图 `out/compare v4.png`，',
    '说明见 C:\\work\\notes\\readme.md。',
    '不要抓 https://example.com/image.png 这种外链。',
  ].join('')
  const refs = extractFileReferences(text)
  assert.ok(refs.includes('color-secrets-class/out/v4-paper-voice.mp4'))
  assert.ok(refs.includes('out/compare v4.png'))
  assert.ok(refs.some((ref) => ref.endsWith('readme.md')))
  assert.ok(!refs.some((ref) => ref.includes('example.com')))
})

test('deduplicates repeated references and ignores unrelated extensions', () => {
  const text = '`out/a.png` 和 `out/a.png`，还有 `src/index.ts`'
  const refs = extractFileReferences(text)
  assert.deepEqual(refs, ['out/a.png'])
})
