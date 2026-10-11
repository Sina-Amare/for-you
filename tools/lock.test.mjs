// node tools/lock.test.mjs
import assert from 'node:assert/strict'
import { normalize, kek, importKey, seal, open, unlock, b64 } from '../lock.js'

assert.equal(normalize('  Kitab! '), 'kitab')
assert.equal(normalize('كتاب'), normalize('کتاب')) // Arabic vs Persian kaf
assert.equal(normalize('پائین'), normalize('پایین'))
assert.equal(normalize('کتا‌ب'), 'کتاب') // ZWNJ
assert.equal(normalize('۱۲۳'), '123')
assert.equal(normalize('کـــتاب'), 'کتاب') // tatweel

const raw = crypto.getRandomValues(new Uint8Array(32))
const key = await importKey(raw)
const msg = new TextEncoder().encode('hello')
assert.deepEqual(await open(key, await seal(key, msg)), msg)

const salt = crypto.getRandomValues(new Uint8Array(16))
const iter = 1000
const wraps = [b64(await seal(await kek('kitab', salt, iter), raw)), b64(await seal(await kek('کتاب', salt, iter), raw))]
const lock = { salt: b64(salt), iter, wraps }
for (const guess of ['Kitab', 'كتاب']) {
  const k = await unlock(lock, guess)
  assert.ok(k, guess)
  assert.deepEqual(await open(k, await seal(key, msg)), msg) // unwrapped key == content key
  assert.equal(k.extractable, false) // the content key never leaves WebCrypto
}
assert.equal(await unlock(lock, 'daftar'), null)
assert.equal(await unlock(lock, '  '), null)
console.log('lock ok')
