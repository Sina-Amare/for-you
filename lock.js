// Shared by the page and tools/build.mjs. Everything personal ships AES-GCM encrypted
// under one content key; that key is wrapped once per accepted answer.
const te = new TextEncoder()
const subtle = globalThis.crypto.subtle

export const ITER = 600_000 // OWASP's PBKDF2-SHA256 figure; ~1-2s on a mid-range phone, hidden by the unlock animation

export const b64 = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0))

// Lenient on purpose: "Kitab!" and " kitab" match, and so do "كتاب" (Arabic kaf) and "کتا‌ب" (ZWNJ) for "کتاب".
export const normalize = (s) => s.normalize('NFKC').toLowerCase()
  .replace(/[يىئ]/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/[أإآٱ]/g, 'ا')
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
  .replace(/ـ/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '')

export async function kek(answer, salt, iterations = ITER) {
  const base = await subtle.importKey('raw', te.encode(normalize(answer)), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt', 'unwrapKey'])
}

export const importKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

// Format: iv (12 bytes) | ciphertext + tag
export async function seal(key, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}

export async function open(key, sealed) {
  const b = new Uint8Array(sealed)
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12)))
}

// lock = { salt, iter, wraps: [b64(seal(kek(answer), contentKeyRaw))] } → content key, or null if wrong.
// unwrapKey: the content key's raw bytes never pass through page memory.
export async function unlock(lock, answer) {
  if (!normalize(answer)) return null
  const k = await kek(answer, unb64(lock.salt), lock.iter)
  for (const w of lock.wraps) {
    const b = unb64(w)
    try {
      return await subtle.unwrapKey('raw', b.subarray(12), k, { name: 'AES-GCM', iv: b.subarray(0, 12) }, 'AES-GCM', false, ['encrypt', 'decrypt'])
    } catch { /* not this wrap */ }
  }
  return null
}
