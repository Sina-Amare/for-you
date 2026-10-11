// Encrypts the photos + words into assets/ (c.txt, p/*.txt, gallery thumbnails t/*.txt) so the public repo holds nothing readable.
// Inputs (git-ignored, never published):
//   Us/                    original photos
//   private/content.json   { lang, gate: {public pre-unlock copy}, photos: {id: {file, focal}}, ...everything else }
//   private/secrets.json   { answers: [...], key: (auto-generated, never change it), github: {repo, branch, dir, token} }
// Usage: node tools/build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { b64, unb64, kek, importKey, seal, ITER } from '../lock.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const p = (...s) => join(root, ...s)
const json = async (f) => JSON.parse(await readFile(p(f), 'utf8'))

const secrets = await json('private/secrets.json')
if (!secrets.key) {
  // Uploaded gallery photos are encrypted with this key too, so it must survive every rebuild.
  secrets.key = b64(crypto.getRandomValues(new Uint8Array(32)))
  await writeFile(p('private/secrets.json'), JSON.stringify(secrets, null, 2))
  console.log('generated a content key in private/secrets.json - back it up, never change it')
}
const raw = unb64(secrets.key)
const key = await importKey(raw)
const content = await json('private/content.json')

const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a])
const dims = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim().split(',').map(Number)

const tmp = mkdtempSync(join(tmpdir(), 'lovegallery-'))
await mkdir(p('assets/p'), { recursive: true })
await mkdir(p('assets/t'), { recursive: true })
for (const [id, photo] of Object.entries(content.photos)) {
  const src = p('Us', photo.file)
  const full = join(tmp, `${id}.webp`)
  const small = join(tmp, `${id}.t.webp`)
  const tiny = join(tmp, `${id}.jpg`)
  ff('-i', src, '-vf', "scale='min(2000,iw)':'min(2000,ih)':force_original_aspect_ratio=decrease",
    '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', '82', '-compression_level', '6', full)
  // gallery tiles: a 2-column phone grid needs ~500px; a tenth of the bytes of the full photo
  ff('-i', src, '-vf', "scale='min(560,iw)':-2:flags=lanczos", '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', '74', '-compression_level', '6', small)
  // pre-blurred here once, so the page never has to animate a CSS blur over a full-screen layer (mid-range phones)
  ff('-i', src, '-vf', 'scale=32:-2:flags=area,gblur=sigma=1.6', '-map_metadata', '-1', '-q:v', '3', tiny)
  ;[photo.w, photo.h] = dims(full)
  photo.ph = `data:image/jpeg;base64,${readFileSync(tiny).toString('base64')}`
  photo.src = `assets/p/${id}.txt` // .txt, not .bin: download managers (IDM) pop up on .bin/.m4a responses
  photo.thumb = `assets/t/${id}.txt`
  delete photo.file
  await writeFile(p(photo.src), await seal(key, readFileSync(full)))
  await writeFile(p(photo.thumb), await seal(key, readFileSync(small)))
}
rmSync(tmp, { recursive: true, force: true })

const { gate, lang } = content
delete content.gate
// The gallery token can also just be pasted into private/gallery-token.txt.
const token = secrets.github?.token || (await readFile(p('private/gallery-token.txt'), 'utf8').catch(() => '')).trim()
content.github = secrets.github && token ? { ...secrets.github, token } : null // only ever travels inside the encrypted bundle
if (secrets.github && !token) console.log('no gallery token yet: the shared gallery stays read-only (paste it into private/gallery-token.txt)')
await writeFile(p('assets/c.txt'), await seal(key, new TextEncoder().encode(JSON.stringify(content))))

const salt = crypto.getRandomValues(new Uint8Array(16))
const wraps = []
for (const a of secrets.answers) wraps.push(b64(await seal(await kek(a, salt), raw)))
await writeFile(p('lock.json'), JSON.stringify({ lang, gate, iter: ITER, salt: b64(salt), wraps }))

// cache-bust the code: GitHub Pages lets browsers keep files 10 minutes, so stamp a content hash into index.html
const { createHash } = await import('node:crypto')
const code = ['app.js', 'lock.js', 'sound.js', 'gallery.js', 'style.css'].map((f) => readFileSync(p(f))).join('')
const ver = createHash('sha256').update(code).digest('hex').slice(0, 8)
const html = readFileSync(p('index.html'), 'utf8')
await writeFile(p('index.html'), html.replace(/\?v=[0-9a-f]{8}/g, `?v=${ver}`))

console.log(`built ${Object.keys(content.photos).length} photos, ${wraps.length} accepted answers, code version ${ver}`)
