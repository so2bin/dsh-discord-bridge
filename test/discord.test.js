import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, downloadAttachment, INTENTS } from '../discord.js'

test('chunkText leaves short text untouched', () => {
  assert.deepEqual(chunkText('hello', 10), ['hello'])
  assert.deepEqual(chunkText('', 10), [''])
})

test('chunkText splits a long run without losing bytes', () => {
  const text = 'x'.repeat(500)
  const chunks = chunkText(text, 100)
  assert.equal(chunks.length, 5)
  assert.ok(chunks.every((chunk) => chunk.length <= 100))
  assert.equal(chunks.join(''), text)
})

test('chunkText preserves text when cutting at whitespace', () => {
  const text = 'word '.repeat(120).trim()
  const chunks = chunkText(text, 100)
  assert.ok(chunks.every((chunk) => chunk.length <= 100))
  assert.equal(chunks.join(''), text)
})

test('attachment download rejects non-HTTPS URLs', async () => {
  await assert.rejects(() => downloadAttachment('ftp://example.com/a.png'), /unsupported attachment protocol/)
})

test('gateway intents keep the message-content bit', () => {
  assert.equal(INTENTS.MESSAGE_CONTENT, 1 << 15)
  assert.equal(INTENTS.GUILD_MESSAGES, 1 << 9)
})
