import { unlock, open } from './lock.js'
import * as snd from './sound.js'
import { createGallery } from './gallery.js'

// ---------- small things ----------
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const params = new URLSearchParams(location.search)
const QA = params.has('qa')
const D = (ms) => (QA ? ms / 4 : ms) // auto-delays only, never animation lengths
const EASE = 'cubic-bezier(.2,.7,.1,1)'
const rmq = matchMedia('(prefers-reduced-motion: reduce)')
let reduce = rmq.matches
rmq.addEventListener?.('change', (e) => { reduce = e.matches })
const store = {
  get (k) { try { return localStorage.getItem(k) } catch { return null } },
  set (k, v) { try { localStorage.setItem(k, v) } catch {} },
}
const vibrate = (p) => { try { navigator.vibrate?.(p) } catch {} }
const settle = (a) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve())
const desk = () => innerWidth >= 900
const cancelAnims = (el) => el.getAnimations().forEach((a) => a.cancel())
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi']

// ---------- the Persian half-space in WebKit (Safari, Telegram iOS) ----------
// WebKit picks one font per grapheme cluster, and a ZWNJ belongs to the letter before it. Markazi has no glyph
// for U+200C, so WebKit draws that letter in a system font, cut off from its word ("کلم ه ست"). A ZWNJ in an
// element of its own is a cluster of its own: the letter stays in Markazi, and the word still breaks there.
// ponytail: patching U+200C into the Markazi woff2 files would fix inputs/placeholders too; this covers the page text.
if (/^Apple/.test(navigator.vendor || '')) {
  const ZW = '‌'
  const split = (t) => {
    const f = document.createDocumentFragment()
    t.data.split(ZW).forEach((s, i) => {
      if (i) { const z = document.createElement('span'); z.className = 'zw'; z.textContent = ZW; f.append(z) }
      if (s) f.append(s)
    })
    t.replaceWith(f)
  }
  const skip = (el) => !el || el.closest('.zw, .verse') // Nastaliq has the glyph; leave the couplet whole
  const zwnj = (n) => {
    if (n.nodeType === 3) { if (n.data.includes(ZW) && !skip(n.parentElement)) split(n); return }
    if (n.nodeType !== 1 || skip(n)) return
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT), hits = []
    while (w.nextNode()) if (w.currentNode.data.includes(ZW) && !skip(w.currentNode.parentElement)) hits.push(w.currentNode)
    hits.forEach(split)
  }
  new MutationObserver((rs) => rs.forEach((r) => r.addedNodes.forEach(zwnj))).observe(document.body, { childList: true, subtree: true })
}

// ---------- language ----------
let lang = 'fa', lock = null, content = null, key = null
const t = (v) => (v == null ? '' : typeof v === 'string' ? v : (v[lang] ?? v.en ?? ''))
const tl = (v) => (v && (Array.isArray(v[lang]) && v[lang].length ? v[lang] : v.en)) || []
const ARIA = { en: { lang: 'language', mute: 'mute' }, fa: { lang: 'زبان', mute: 'بی‌صدا' } }
function setLang (l) {
  lang = l === 'fa' ? 'fa' : 'en'
  const h = document.documentElement
  h.lang = lang
  h.dir = lang === 'fa' ? 'rtl' : 'ltr'
  $('#lang').textContent = lang === 'fa' ? 'EN' : 'فا'
  $('#lang').setAttribute('aria-label', ARIA[lang].lang)
  $('#mute').setAttribute('aria-label', ARIA[lang].mute)
}
function fmtDate (iso) {
  if (!iso) return ''
  const d = new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso)
  if (isNaN(d)) return ''
  try { return new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR-u-ca-persian' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d) } catch { return '' }
}

// ---------- runs: every screen/scene owns its timers; leaving it cancels them ----------
let run = { alive: true, timers: new Set() }
function freshRun () {
  run.alive = false
  run.timers.forEach(clearTimeout)
  run = { alive: true, timers: new Set() }
  return run
}
function later (fn, ms, r = run) {
  const id = setTimeout(() => { r.timers.delete(id); if (r.alive) fn() }, ms)
  r.timers.add(id)
  return id
}
const wait = (ms, r = run) => new Promise((res) => later(res, ms, r))
let skipper = null // a tap cuts the current skippable wait short
function waitTap (ms, r = run) {
  return new Promise((res) => {
    const done = () => { clearTimeout(id); if (skipper === done) skipper = null; if (r.alive) res() }
    const id = later(done, ms, r)
    skipper = done
  })
}

// ---------- words ----------
// Each word becomes an inline-block span (the unit the reveal animates). Inline-blocks are atomic to the
// bidi algorithm, so split one by one, a Latin phrase inside a Persian line would come out in reverse word order.
// A run of opposite-direction words therefore stays in ONE isolated span, and the punctuation at its
// edges stays outside it, in the sentence's own direction. The text itself is never changed.
const RTL_L = /[\p{Script=Arabic}\p{Script=Hebrew}]/u
const wordDir = (w) => { for (const c of w) if (/\p{L}/u.test(c)) return RTL_L.test(c) ? 'rtl' : 'ltr'; return '' }
// the text as pieces: a single word, or a whole opposite-direction run as [lead punctuation, isolate, trail punctuation]
function bidiPieces (text) {
  const words = String(text).split(/\s+/).filter(Boolean), dirs = words.map(wordDir)
  const n = (d) => dirs.filter((x) => x === d).length
  const base = n('rtl') > n('ltr') ? 'rtl' : n('ltr') > n('rtl') ? 'ltr' : lang === 'fa' ? 'rtl' : 'ltr'
  const pieces = []
  for (let i = 0; i < words.length;) {
    const opp = dirs[i] && dirs[i] !== base
    // the run: opposite words, the neutral ones between them, and the numbers that read with them ("CC BY 3.0")
    let j = i
    if (opp) for (let k = i + 1; k < words.length && dirs[k] !== base; k++) if (dirs[k] || /\p{N}/u.test(words[k])) j = k
    if (!opp) pieces.push([words[i]])
    else {
      const [, lead, core, trail] = words.slice(i, j + 1).join(' ').match(/^([^\p{L}\p{N}\p{M}]*)(.*?)([^\p{L}\p{N}\p{M}]*)$/su)
      const iso = document.createElement('span')
      iso.className = 'iso'
      iso.dir = dirs[i]
      iso.textContent = core
      pieces.push([lead, iso, trail].filter((x) => x !== ''))
    }
    i = j + 1
  }
  return { base, pieces }
}
function splitWords (el, text) {
  const { base, pieces } = bidiPieces(text)
  el.textContent = ''
  el.dir = base // explicit, so the line and its runs agree on direction
  pieces.forEach((nodes, i) => {
    const s = document.createElement('span')
    s.className = 'w'
    s.append(...nodes)
    if (i) el.append(' ')
    el.append(s)
  })
  return el
}
// text that is not split into words (credits) gets the same care: a run never breaks apart or reorders
function setText (el, text) {
  const { base, pieces } = bidiPieces(text)
  el.textContent = ''
  el.dir = base
  pieces.forEach((nodes, i) => { if (i) el.append(' '); el.append(...nodes) })
  return el
}
// a bare middle dot beside Persian digits reads as a zero ("۵ · ۶" looks like "۵۰۶"). Same text, more air.
function setParts (el, parts) {
  el.textContent = ''
  parts.filter(Boolean).forEach((p, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '·'; el.append(s) }
    el.append(p)
  })
  return el
}
function mkLine (text, cls = 'line') {
  const p = document.createElement('p')
  p.className = cls
  p.dir = 'auto'
  return splitWords(p, text)
}
function revealWords (el, { dur = 700, stagger = 55, delay = 0, blur = 6 } = {}) {
  if (reduce) return settle(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay, fill: 'backwards' }))
  const kf = [{ opacity: 0, filter: `blur(${blur}px)`, transform: 'translateY(.45em)' }, { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0)' }]
  return Promise.all($$('.w', el).map((s, i) => settle(s.animate(kf, { duration: dur, delay: delay + i * stagger, easing: EASE, fill: 'backwards' }))))
}
function fadeTo (el, to, ms, easing = EASE) {
  const from = +getComputedStyle(el).opacity
  cancelAnims(el)
  el.style.opacity = to
  if (!ms || from === to) return null
  return el.animate([{ opacity: from }, { opacity: to }], { duration: reduce ? Math.min(ms, 300) : ms, easing })
}

// ---------- global layers ----------
const floodEl = $('#flood')
const floodTo = (to, ms, easing) => fadeTo(floodEl, to, ms, easing)
const washLayers = $$('#wash .wl')
let washTop = 0, washSrc = '', washTok = 0
function wash (ph) {
  if (!ph || ph === washSrc) return
  washSrc = ph
  const tok = ++washTok, nxt = washLayers[1 - washTop], img = nxt.firstElementChild
  img.src = ph
  const swap = () => {
    if (tok !== washTok) return
    nxt.style.opacity = 1
    washLayers[washTop].style.opacity = 0
    washTop = 1 - washTop
  }
  img.decode().then(swap, swap)
}
const washDim = (v) => { $('#wash').style.opacity = v }
const orsi = (mode = '') => { $('#orsi').className = mode }
function grainTile () {
  const c = document.createElement('canvas')
  c.width = c.height = 160
  const x = c.getContext('2d'), d = x.createImageData(160, 160)
  for (let i = 0; i < d.data.length; i += 4) {
    const v = (Math.random() * 255) | 0
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v
    d.data[i + 3] = 255
  }
  x.putImageData(d, 0, 0)
  document.documentElement.style.setProperty('--grain', `url(${c.toDataURL('image/png')})`)
  c.width = c.height = 0
}

// ---------- photos: decrypt once to blob URLs ----------
// A version query on every sealed file: phones keep stale copies otherwise once the content is rebuilt.
// Sealed files are named .txt: download managers (IDM) grab .bin/.m4a responses.
let V = '1'
const versioned = (u) => `${u}${u.includes('?') ? '&' : '?'}v=${V}`
function versionFrom (s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
const cache = new Map()
function sealedImage (src) {
  let p = cache.get(src)
  if (!p) {
    p = (async () => {
      const res = await fetch(versioned(src))
      if (!res.ok) throw new Error('photo ' + res.status)
      const blob = new Blob([await open(key, await res.arrayBuffer())], { type: 'image/webp' })
      return { blob, url: URL.createObjectURL(blob) }
    })()
    p.catch(() => cache.delete(src))
    cache.set(src, p)
  }
  return p
}
const photo = (id) => sealedImage(content.photos[id].src)
const thumb = (id) => sealedImage(content.photos[id].thumb || content.photos[id].src) // the small gallery copy
async function bgDecrypt () {
  const order = []
  const add = (id) => { if (id && content.photos[id] && !order.includes(id)) order.push(id) }
  content.scenes.forEach((s) => s.photos.forEach(add))
  add(content.hold?.photo)
  Object.keys(content.photos).sort().forEach(add)
  for (const id of order) await photo(id).catch(() => {})
}
async function setImg (img, url) {
  if (img.getAttribute('src') !== url) img.src = url
  try { await img.decode() } catch {}
}
function slotSet (ph, id, alt) {
  const meta = content.photos[id]
  const [fx, fy] = meta.focal || [0.5, 0.5]
  const pos = `${(fx * 100).toFixed(1)}% ${(fy * 100).toFixed(1)}%`
  const [soft, sharp] = ph.children
  cancelAnims(ph); cancelAnims(sharp)
  soft.src = meta.ph
  soft.style.objectPosition = sharp.style.objectPosition = pos
  sharp.alt = alt
  sharp.style.opacity = 0
  ph.style.transformOrigin = pos
  ph.style.transform = ''
  ph.dataset.id = id
  ph.pushed = false
}
// develop: the sharp layer's opacity and its wrapper's scale; filters stay static (iOS)
function develop (ph, haze, bloom, r) {
  const sharp = ph.children[1]
  cancelAnims(sharp); cancelAnims(ph)
  sharp.style.opacity = 1
  if (reduce) {
    sharp.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 })
    if (haze) fadeTo(haze, 0, 300)
    if (bloom) fadeTo(bloom, 0, 300)
    return wait(300, r)
  }
  sharp.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1600, easing: EASE })
  const a = ph.animate([{ transform: 'scale(1.07)' }, { transform: 'scale(1.02)' }], { duration: 1600, easing: EASE, fill: 'forwards' })
  if (haze) fadeTo(haze, 0, 1600)
  if (bloom) fadeTo(bloom, 0, 1100)
  settle(a).then(() => { if (r.alive) kenBurns(ph) })
  return wait(1600, r)
}
function kenBurns (ph) {
  if (reduce || ph.pushed) return null
  const [fx, fy] = content.photos[ph.dataset.id]?.focal || [0.5, 0.5]
  const tx = ((0.5 - fx) * 5).toFixed(2), ty = ((0.5 - fy) * 5).toFixed(2)
  const a = ph.animate([{ transform: 'scale(1.02)' }, { transform: `translate(${tx}%, ${ty}%) scale(1.08)` }],
    { duration: 14000, easing: 'cubic-bezier(.33,.08,.3,1)', fill: 'forwards' })
  if (S.held && current === 'story') a.pause()
  return a
}
// a line asks to look closer: the camera glides from wherever it is towards one point [u, v] of the photo,
// as far as it can without uncovering the arch (the photo is object-fit: cover around its focal point)
function pushIn (ph, [u, v]) {
  const meta = content.photos[ph.dataset.id]
  if (reduce || !meta) return
  const W = ph.offsetWidth, H = ph.offsetHeight, Z = 1.24
  const [fx, fy] = meta.focal || [0.5, 0.5]
  const s = Math.max(W / (meta.w || W), H / (meta.h || H)), dw = (meta.w || W) * s, dh = (meta.h || H) * s
  const px = (W - dw) * fx + u * dw, py = (H - dh) * fy + v * dh // the point, in the arch's pixels
  const ox = fx * W, oy = fy * H // the transform origin
  const dx = Math.max(-(Z - 1) * (W - ox), Math.min((Z - 1) * ox, W / 2 - ox - Z * (px - ox)))
  const dy = Math.max(-(Z - 1) * (H - oy), Math.min((Z - 1) * oy, H * 0.46 - oy - Z * (py - oy)))
  const from = getComputedStyle(ph).transform
  ph.getAnimations().forEach((a) => { if (a.effect?.getKeyframes?.().some((f) => 'transform' in f)) a.cancel() }) // not a crossfade
  ph.pushed = true
  const a = ph.animate([{ transform: from }, { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${Z})` }],
    { duration: 3400, easing: 'cubic-bezier(.45,.05,.2,1)', fill: 'forwards' })
  if (S.held && current === 'story') a.pause()
}

// ---------- screens ----------
const SECTIONS = { gate: '#s-gate', menu: '#s-menu', opening: '#s-opening', story: '#s-story', interlude: '#s-interlude', hold: '#s-hold', letter: '#s-letter', credits: '#s-credits', gallery: '#s-gallery' }
const screens = {}
let current = 'gate'
let state = { screen: 'gate', index: 0 }
const setState = (screen, index = 0) => { state = { screen, index } }
// "seen" lives in this browser only (each device remembers on its own); ?fresh resets it here
if (new URLSearchParams(location.search).has('fresh')) store.set('lg-seen', '0')
let seen = store.get('lg-seen') === '1'
// Fixed links decide where the answer leads (no hidden state): …/for-you/ plays the film,
// …/for-you/?gallery opens the gallery, …/for-you/?menu the chapter menu.
const START = params.has('gallery') || location.hash === '#gallery' ? 'gallery'
  : params.has('menu') || location.hash === '#menu' ? 'menu' : 'opening'

async function show (name, arg = 0, { instant = false } = {}) {
  const r = freshRun()
  const from = current
  const cross = !instant && from !== name
  if (cross) {
    floodTo(0.5, reduce ? 300 : 520)
    await wait(reduce ? 300 : 520, r)
  }
  if (from !== name) screens[from]?.leave?.()
  current = name
  // reaching the letter is "seen it": next visit opens on the menu (credits may be skipped or cut short)
  if (!seen && (name === 'letter' || name === 'credits' || name === 'gallery')) { seen = true; store.set('lg-seen', '1') }
  if (instant) document.body.classList.add('instant')
  for (const [n, sel] of Object.entries(SECTIONS)) $(sel).classList.toggle('on', n === name)
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('instant')))
  setState(name === 'story' ? 'scene' : name, arg)
  updateSkip()
  screens[name].enter(arg, { r, instant })
  if (cross) floodTo(0, reduce ? 300 : 1100)
}
function go (name, i = 0) {
  if (!content) return
  const scr = name === 'scene' ? 'story' : name
  if (!screens[scr] || scr === 'gate') return
  floodTo(0, 0)
  show(scr, +i || 0, { instant: true })
}
// once a screen has faded out, drop its full-size images (the blob URLs stay cached for later)
function releaseLater (name, imgs) {
  setTimeout(() => { if (current !== name) imgs.forEach((img) => img.removeAttribute('src')) }, 1200)
}
function updateSkip () { // on a return visit: the opening offers a way straight to the gallery
  const b = $('#skip')
  b.hidden = !(seen && content && current === 'opening')
  if (!b.hidden) b.firstElementChild.textContent = t(content.ui.toGallery)
}

// =====================================================================
// GATE
// =====================================================================
const G = { el: $('#s-gate'), inn: $('.gate-in'), win: $('#win'), input: $('#answer'), form: $('#g-form'), wrong: $('#g-wrong'), hint: $('#g-hint') }
const welcomeEl = $('#welcome')
let wrongI = -1, wrongN = 0, busy = false, cbinP = null
const cbin = () => (cbinP ||= fetch(versioned('assets/c.txt')).then((r) => { if (!r.ok) throw new Error('content ' + r.status); return r.arrayBuffer() })
  .catch((e) => { cbinP = null; throw e }))

function drawWindow (svg) {
  const NS = 'http://www.w3.org/2000/svg'
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e }
  const C = { r: '#b8324a', s: '#e3a03a', c: '#2c58a8', t: '#2aa198', m: '#c8558a', a: '#f2d49c' }
  const cx = 100, cy = 100
  const P = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy - r * Math.sin(a)).toFixed(2)}`
  const panes = []
  const fan = ['c', 's', 'r', 'a', 'a', 'r', 's', 'c'] // a symmetric orsi fanlight
  for (let k = 0; k < 8; k++) {
    const a0 = (k * Math.PI) / 8 + 0.02, a1 = ((k + 1) * Math.PI) / 8 - 0.02, r1 = 23, r2 = 83
    panes.push([`M${P(r1, a0)}L${P(r2, a0)}A${r2} ${r2} 0 0 0 ${P(r2, a1)}L${P(r1, a1)}A${r1} ${r1} 0 0 1 ${P(r1, a0)}Z`, fan[k]])
  }
  panes.push([`M${cx - 17} ${cy - 1.5}A17 17 0 0 1 ${cx + 17} ${cy - 1.5}Z`, 's'])
  const gx0 = 14, gx1 = 186, gy0 = 106, gy1 = 280, cw = (gx1 - gx0) / 3, rh = (gy1 - gy0) / 4, ins = 2.6
  const grid = [['c', 'm', 'c'], ['s', 'a', 's'], ['t', 'a', 't'], ['r', 'c', 'r']]
  for (let rr = 0; rr < 4; rr++) for (let c = 0; c < 3; c++) {
    const x = gx0 + c * cw + ins, y = gy0 + rr * rh + ins
    panes.push([`M${x} ${y}h${cw - 2 * ins}v${rh - 2 * ins}h${-(cw - 2 * ins)}Z`, grid[rr][c]])
  }
  const g = mk('g', {})
  panes.forEach(([d, c], k) => {
    const p = mk('path', { d, fill: C[c], class: `pn f${1 + (k % 3)}` })
    p.style.setProperty('--k', k)
    g.append(p)
  })
  svg.append(g)
  const leads = [
    'M8 286V100A92 92 0 0 1 192 100V286Z',
    'M14 280V100A86 86 0 0 1 186 100V280Z',
    'M14 100H186', 'M14 106H186',
    `M${cx - 20} ${cy}A20 20 0 0 1 ${cx + 20} ${cy}`,
    `M${gx0 + cw} 106V280`, `M${gx0 + 2 * cw} 106V280`,
    ...[1, 2, 3].map((k) => `M14 ${gy0 + k * rh}H186`),
    ...[1, 2, 3, 4, 5, 6, 7].map((k) => `M${P(20, (k * Math.PI) / 8)}L${P(86, (k * Math.PI) / 8)}`),
  ]
  leads.forEach((d, i) => svg.append(mk('path', { d, class: i < 2 ? 'lead' : 'lead thin' })))
  svg.append(mk('path', { d: 'M2 287.5H198', class: 'lead' }))
}

function renderGate () {
  const g = lock.gate
  $('#g-label').textContent = t(g.label)
  $('#g-intro').textContent = t(g.intro)
  $('#g-q').textContent = t(g.question)
  G.input.placeholder = t(g.placeholder)
  $('#open span').textContent = t(g.button)
  const list = tl(g.wrong)
  G.wrong.textContent = wrongI >= 0 && list.length ? list[wrongI % list.length] : ''
  G.hint.textContent = t(g.hint)
  welcomeEl.textContent = t(g.welcome)
  // the gate verse, shown from the start
  const v = g.verse
  $('#g-verse').hidden = !v
  if (v) {
    $('#g-vlabel').textContent = g.verseLabel ? t(g.verseLabel) : ''
    $('#g-vtext').textContent = v.fa
    $('#g-ven').textContent = lang === 'en' ? `${v.en}\n${t(v.poet)}` : t(v.poet)
  }
}

function wrongAnswer () {
  snd.tick()
  G.input.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(-2px)' },
    { transform: 'translateX(1.2px)' }, { transform: 'translateX(-.4px)' }, { transform: 'translateX(0)' }], { duration: 460, easing: 'cubic-bezier(.3,.6,.3,1)' })
  G.win.classList.add('dim')
  setTimeout(() => G.win.classList.remove('dim'), 300)
  // after the third miss the hint arrives, and stays (quietly) until the gate opens
  if (++wrongN >= 3 && G.hint.textContent) G.hint.classList.add('on')
  const list = tl(lock.gate.wrong)
  if (!list.length) return
  wrongI = (wrongI + 1) % list.length
  G.wrong.textContent = list[wrongI]
  cancelAnims(G.wrong)
  G.wrong.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 650, easing: EASE })
}

async function success (k) {
  key = k
  const r = freshRun()
  G.input.blur()
  snd.musicTo(0.55, 3)
  document.body.classList.add('playing')
  const ready = (async () => {
    const buf = await cbin()
    content = JSON.parse(new TextDecoder().decode(await open(key, buf)))
    afterUnlock()
  })()
  ready.catch(() => {})
  // 1. the words dissolve
  for (const el of G.inn.children) {
    if (el === G.win) continue
    el.animate([{ opacity: getComputedStyle(el).opacity, filter: 'blur(0px)' }, { opacity: 0, filter: reduce ? 'blur(0px)' : 'blur(8px)' }], { duration: reduce ? 300 : 700, easing: EASE, fill: 'forwards' })
  }
  // 2. the panes light one by one, each with a faint glass chime
  const panes = $$('.pn', G.win)
  for (let i = panes.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [panes[i], panes[j]] = [panes[j], panes[i]] }
  G.win.classList.add('lit')
  let at = 160
  panes.forEach((p, i) => {
    later(() => { p.classList.add('on'); snd.chime(i % 2 ? (Math.random() * 10) | 0 : (Math.random() * 5) | 0, 0.018) }, at, r)
    at += 40 + Math.random() * 20
  })
  // 3. the window grows while warm light floods in (music is already fading in); the welcome surfaces in the light
  await wait(reduce ? 300 : 950, r)
  if (!reduce) G.win.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.55)' }], { duration: 2000, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' })
  floodTo(1, reduce ? 300 : 1550, 'cubic-bezier(.5,0,.3,1)')
  const hello = !!welcomeEl.textContent
  if (hello) {
    later(() => {
      welcomeEl.style.opacity = 1
      welcomeEl.animate(reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, filter: 'blur(9px)', transform: 'scale(.97)' }, { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' }],
        { duration: reduce ? 300 : 1300, easing: EASE })
    }, reduce ? 0 : 550, r)
  }
  await wait(reduce ? 350 : 1600, r)
  try { await ready } catch {
    // could not read the content (network): put the gate back
    floodTo(0, 600); cancelAnims(G.win); $$('.pn', G.win).forEach((p) => p.classList.remove('on')); G.win.classList.remove('lit')
    for (const el of G.inn.children) cancelAnims(el)
    cancelAnims(welcomeEl); welcomeEl.style.opacity = 0
    busy = false
    return wrongAnswer()
  }
  G.input.value = '' // open now: the password does not stay in the field
  if (!r.alive) return
  if (hello) await wait(reduce ? 900 : 1300, r) // long enough to read it
  // 4. the light settles to reveal the opening (or, once it has all been seen, the menu); the welcome dissolves back into it
  show(START, 0, { instant: true })
  floodTo(0, reduce ? 300 : 1700, 'cubic-bezier(.3,0,.2,1)')
  if (hello) {
    welcomeEl.style.opacity = 0
    welcomeEl.animate(reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(6px)' }], { duration: reduce ? 300 : 900, easing: EASE })
  }
}

function afterUnlock () {
  buildSegs()
  if (START !== 'gallery') bgDecrypt() // straight to the gallery: leave the bandwidth to its thumbnails
  screens.gallery = createGallery({ content, key, t, tl, getLang: () => lang, photo, thumb, store, D, snd, fmtDate, setParts, wash, orsi, washDim, reduce: () => reduce, settle, EASE, show: (n) => show(n) })
  window.__lg = { go, get state () { return { ...state } } }
}

function bootGate () {
  drawWindow(G.win)
  renderGate()
  const kids = [...G.inn.children]
  kids.forEach((el, i) => { el.style.transitionDelay = `${i * 110}ms` })
  G.win.style.transition = 'opacity 1.2s var(--ease), transform .5s var(--ease)'
  requestAnimationFrame(() => G.el.classList.add('ready'))
  setTimeout(() => kids.forEach((el) => { el.style.transitionDelay = '' }), 2200)
  const warm = () => {
    cbin().catch(() => {})
    try { document.fonts?.load('28px "Love Nastaliq"', 'عشق').catch(() => {}) } catch {}
  }
  G.input.addEventListener('input', warm, { once: true })
  G.input.addEventListener('focus', warm, { once: true })
  G.form.addEventListener('submit', async (e) => {
    e.preventDefault()
    snd.start() // the user gesture: AudioContext + (silent) music, before any await
    if (busy) return
    busy = true
    G.el.classList.add('listen')
    let k = null
    try { k = await unlock(lock, G.input.value) } catch {}
    G.el.classList.remove('listen')
    if (!k) { busy = false; return wrongAnswer() }
    success(k)
  })
  // iOS: the keyboard covers the lower ~45%; lift the gate so the answer stays above it
  const vv = window.visualViewport
  let lift = 0
  const fit = () => {
    const kb = vv ? innerHeight - vv.height : 0
    if (!vv || busy || document.activeElement !== G.input || kb < 120) {
      lift = 0; G.inn.style.transform = ''; G.win.style.transform = ''; G.win.style.transformOrigin = ''
      return
    }
    const bottom = (G.hint.classList.contains('on') ? G.hint : G.wrong).getBoundingClientRect().bottom + lift
    lift = Math.max(0, bottom + 16 - (vv.offsetTop + vv.height))
    G.inn.style.transform = `translateY(${-lift}px)`
    G.win.style.transform = lift > 0 ? 'scale(.62)' : ''
    G.win.style.transformOrigin = lift > 0 ? '50% 100%' : ''
  }
  vv?.addEventListener('resize', fit)
  G.input.addEventListener('focus', () => setTimeout(fit, 60))
  G.input.addEventListener('blur', () => setTimeout(fit, 60))
}
screens.gate = { enter () {}, relang: renderGate }

// =====================================================================
// MENU (return visits, once it has all been seen): again, a chapter, the letter, or the gallery
// =====================================================================
function renderMenu () {
  const u = content.ui
  $('#m-back').textContent = t(u.welcomeBack)
  $('#m-title').textContent = t(content.title)
  $('#m-again span').textContent = t(u.again)
  $('#m-gallery span').textContent = t(u.toGallery)
  $('#m-chap-label').textContent = t(u.chapters)
  const nav = $('#m-chapters')
  nav.textContent = ''
  const item = (n, label, go) => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'chap'
    const i = document.createElement('span'); i.className = 'chap-n'; i.textContent = n
    const l = document.createElement('span'); l.className = 'chap-l'; l.dir = 'auto'; l.textContent = label
    b.append(i, l)
    b.addEventListener('click', go)
    nav.append(b)
  }
  const n = (k) => (lang === 'fa' ? k.toLocaleString('fa-IR') : ROMAN[k - 1] || String(k))
  content.scenes.forEach((sc, i) => item(n(i + 1), t(sc.label), () => show('story', i)))
  item('·', t(u.letterChap), () => show('letter'))
}
screens.menu = {
  enter () {
    renderMenu()
    orsi(''); washDim(0.5)
    wash(content.photos[content.scenes[0].photos[0]]?.ph)
  },
  relang: renderMenu,
}
$('#m-again').addEventListener('click', () => show('opening'))
$('#m-gallery').addEventListener('click', () => show('gallery'))

// =====================================================================
// OPENING
// =====================================================================
const OP = { el: $('#s-opening'), epi: $('.epi'), m: $$('.verse .m'), poet: $('.poet'), en: $('.epi-en'), tb: $('.tblock'), title: $('.title'), date: $('.odate'), lines: $('.olines'), begin: $('.begin') }
const O = { stage: 0, shown: 0 }
// a hemistich never wraps (an orphaned word breaks the couplet): shrink the verse until the wider one fits
function fitVerse () {
  const v = OP.m[0].parentElement
  v.style.fontSize = ''
  const pad = parseFloat(getComputedStyle(OP.m[0]).paddingLeft) * 2
  const avail = OP.epi.clientWidth, widest = Math.max(...OP.m.map((m) => m.offsetWidth - pad))
  if (avail && widest > avail) v.style.fontSize = `${(parseFloat(getComputedStyle(v).fontSize) * avail / widest).toFixed(2)}px`
}
function renderOpening (fresh) {
  const e = content.epigraph
  const verse = String(e.fa || '').split(/\s*\n\s*|\s+\/\s+/)
  OP.m[0].textContent = verse[0] || ''
  OP.m[1].textContent = verse.slice(1).join(' ')
  OP.poet.textContent = t(e.poet)
  OP.en.textContent = lang === 'fa' ? '' : (e.en || '') // the English rendering is for English readers
  fitVerse()
  splitWords(OP.title, t(content.title))
  setParts(OP.date, t(content.date).split(' · '))
  $('span', OP.begin).textContent = t(content.ui.begin)
  const lines = tl(content.opening)
  OP.lines.textContent = ''
  lines.forEach((l, i) => {
    const p = mkLine(l, 'oline')
    if (!fresh && i < O.shown) p.classList.add('on')
    if (!fresh && i < O.shown - 1) p.classList.add('past')
    OP.lines.append(p)
  })
}
screens.opening = {
  async enter (arg, { r }) {
    O.stage = 0; O.shown = 0
    renderOpening(true)
    OP.epi.classList.remove('out'); OP.epi.style.visibility = ''
    OP.m.forEach((m) => m.classList.remove('ink', 'done'))
    OP.poet.style.opacity = 0; OP.en.style.opacity = 0; OP.date.style.opacity = 0
    OP.tb.classList.remove('on'); OP.begin.classList.remove('on')
    loveSaid = false // watching again: the question comes again
    const last = content.scenes[content.scenes.length - 1]
    wash(content.photos[last.photos[0]]?.ph); washDim(0.75); orsi('')
    try { await Promise.race([document.fonts.load('28px "Love Nastaliq"', 'عشق'), wait(1500, r)]) } catch {}
    if (!r.alive) return
    fitVerse() // measured in the real face
    // the verse, written in its own direction like ink; the mask goes once it is written, so no dot is ever clipped
    if (reduce) OP.m.forEach((m) => { m.style.opacity = 1; m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }) })
    else {
      OP.m[0].classList.add('ink')
      later(() => OP.m[1].classList.add('ink'), 1000, r)
      later(() => OP.m.forEach((m) => m.classList.add('done')), 3300, r)
    }
    later(() => { OP.poet.style.opacity = 1 }, reduce ? 300 : 2300, r)
    later(() => { OP.en.style.opacity = 1 }, reduce ? 300 : 2900, r)
    await waitTap((reduce ? 600 : 3200) + D(6000), r) // about six seconds to read it, or a tap
    titleStage(r)
  },
  leave () { skipper = null; OP.m.forEach((m) => { m.style.opacity = '' }) },
  relang () {
    renderOpening(false)
    if (O.stage >= 1) $$('.w', OP.title).forEach((w) => cancelAnims(w))
    updateSkip()
  },
}
async function titleStage (r) {
  if (O.stage) return
  O.stage = 1
  OP.epi.classList.add('out')
  await wait(reduce ? 300 : 800, r)
  OP.epi.style.visibility = 'hidden'
  OP.tb.classList.add('on')
  revealWords(OP.title, { dur: 1200, stagger: 150, blur: 10 })
  later(() => { OP.date.style.opacity = 1 }, reduce ? 200 : 1100, r)
  await waitTap(1300 + D(1400), r)
  const count = $$('.oline', OP.lines).length
  for (let k = 0; k < count; k++) {
    const ps = $$('.oline', OP.lines) // live: the language toggle may have rebuilt them
    ps.forEach((p, j) => p.classList.toggle('past', j < k))
    ps[k].classList.add('on')
    O.shown = k + 1
    snd.chime(k, 0.012)
    await revealWords(ps[k])
    if (!r.alive) return
    await waitTap(D(900 + 28 * ps[k].textContent.length), r)
  }
  $$('.oline', OP.lines).forEach((p) => p.classList.remove('past'))
  O.stage = 2
  OP.begin.classList.add('on')
}
OP.el.addEventListener('click', (e) => {
  if (current !== 'opening') return
  if (e.target.closest('.begin')) return beginStory()
  if (e.target.closest('button')) return
  if (O.stage === 0) { skipper?.() } else if (O.stage === 1) skipper?.()
  else beginStory()
})
function beginStory () {
  if (current !== 'opening') return
  snd.wake()
  show('story', 0)
}

// =====================================================================
// STORY
// =====================================================================
const ST = {
  el: $('#s-story'), stage: $('#stage'), segs: $('#s-story .segs'), num: $('.chapter .num'), ct: $('.chapter .ct'),
  frame: $('#s-story .frame'), slots: $('#s-story .slots'), A: $$('#s-story .ph')[0], B: $$('#s-story .ph')[1],
  haze: $('#s-story .haze'), bloom: $('#s-story .bloom'), fog: $('#fog'), hint: $('.wipehint'), lines: $('#s-story .lines'),
  placard: $('.placard'), tap: $('.taphint'),
}
const S = { i: 0, shown: 0, total: 0, busy: true, fog: false, tok: 0, auto: null, held: false, visible: false, second: false, paused: [], tapT: 0 }

function buildSegs () {
  ST.segs.textContent = ''
  content.scenes.forEach(() => { const s = document.createElement('i'); s.className = 'seg'; s.append(document.createElement('b')); ST.segs.append(s) })
}
function progress () {
  $$('.seg b', ST.segs).forEach((b, k) => {
    const f = k < S.i ? 1 : k > S.i ? 0 : S.total ? S.shown / S.total : 0
    b.style.transform = `scaleX(${f})`
  })
}
function chapterText () {
  const sc = content.scenes[S.i]
  const n = lang === 'fa' ? (S.i + 1).toLocaleString('fa-IR') : ROMAN[S.i] || String(S.i + 1)
  ST.num.textContent = n
  ST.ct.textContent = t(sc.label)
  ST.placard.textContent = ''
  const a = document.createElement('span'); a.className = 'num'; a.textContent = n
  const b = document.createElement('span'); b.dir = 'auto'; b.textContent = t(sc.label)
  ST.placard.append(a, b)
  ST.tap.textContent = t(content.ui.tap)
}
const mirrored = (sc, k) => (sc.mirror || []).includes(k)
const switchAt = (sc) => sc.switchAt ?? 2
function buildLines (keep = 0) {
  const sc = content.scenes[S.i]
  ST.lines.textContent = ''
  tl(sc.lines).forEach((l, k) => {
    const p = mkLine(l, mirrored(sc, k) ? 'line mirror' : 'line')
    if (k < keep) p.classList.add('on')
    if (k < keep - 1) p.classList.add('past')
    ST.lines.append(p)
  })
}
function hideTap () { clearTimeout(S.tapT); ST.tap.classList.remove('on') }
function scheduleTap () { hideTap(); S.tapT = later(() => ST.tap.classList.add('on'), D(5000)) }
function clearAuto () { if (S.auto?.id) clearTimeout(S.auto.id); S.auto = null }
function scheduleAuto (ms) {
  clearAuto()
  S.auto = { due: performance.now() + ms, left: ms, id: 0 }
  if (!S.held && !document.hidden) S.auto.id = later(fireAuto, ms)
}
function fireAuto () { S.auto = null; revealNext() }
function pauseAuto (on) {
  const a = S.auto
  if (!a) return
  if (on && a.id) { clearTimeout(a.id); a.id = 0; a.left = Math.max(0, a.due - performance.now()) }
  else if (!on && !a.id) { a.due = performance.now() + a.left; a.id = later(fireAuto, a.left) }
}
function holdPause (on) {
  S.held = on
  pauseAuto(on)
  if (on) {
    S.paused = [ST.A, ST.B].flatMap((el) => el.getAnimations()).filter((a) => a.playState === 'running')
    S.paused.forEach((a) => a.pause())
  } else { S.paused.forEach((a) => { if (a.playState === 'paused') a.play() }); S.paused = [] }
}

async function playScene (i, { instant = false } = {}) {
  const r = freshRun()
  i = Math.max(0, Math.min(content.scenes.length - 1, i))
  const sc = content.scenes[i]
  const wasOn = S.visible && !instant
  // walking direction along the wall: forward moves towards the end side, back the other way; mirrored in RTL
  const walk = (i >= S.i ? 1 : -1) * (lang === 'fa' ? -1 : 1)
  S.busy = true; S.fog = false; S.tok++
  clearAuto(); hideTap(); fogStop()
  setState('scene', i)
  if (wasOn) { await exitScene(walk, r); if (!r.alive) return }
  S.i = i; S.shown = 0; S.second = false; S.visible = true
  S.total = tl(sc.lines).length
  chapterText(); progress(); buildLines(0)
  orsi(sc.key === 'glass' ? 'glass' : sc.key === 'brick' ? 'faint' : '')
  wash(content.photos[sc.photos[0]]?.ph); washDim(1)
  cancelAnims(ST.slots); cancelAnims(ST.frame)
  // desktop: the next arch arrives from further along the wall (cancel + start in one task: no jump)
  if (desk() && wasOn && !reduce) ST.frame.animate([{ transform: `translateX(${walk * 30}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], { duration: 1100, easing: EASE })
  slotSet(ST.A, sc.photos[0], t(sc.label))
  ST.A.style.opacity = 1
  ST.B.style.opacity = 0
  if (sc.photos[1]) slotSet(ST.B, sc.photos[1], t(sc.label))
  if (!wasOn) { cancelAnims(ST.bloom); ST.bloom.style.opacity = 0 }
  cancelAnims(ST.haze); ST.haze.style.opacity = sc.moment === 'fog' ? 0 : 0.6
  const p1 = await photo(sc.photos[0]).catch(() => null)
  if (!r.alive) return
  if (p1) await setImg(ST.A.children[1], p1.url)
  if (!r.alive) return
  if (sc.photos[1]) photo(sc.photos[1]).then((p) => { if (r.alive) setImg(ST.B.children[1], p.url) }).catch(() => {})
  const nx = content.scenes[i + 1]
  if (nx) photo(nx.photos[0]).catch(() => {})
  if (sc.moment === 'fog') {
    await fogScene(r)
    if (!r.alive) return
    S.busy = false
    revealNext()
    return
  }
  develop(ST.A, ST.haze, ST.bloom, r)
  S.busy = false
  scheduleAuto(D(800))
}

async function exitScene (dir, r) {
  snd.whoosh()
  hideTap()
  const dur = reduce ? 300 : 650
  for (const p of $$('.line.on', ST.lines)) {
    const o = +getComputedStyle(p).opacity
    p.animate([{ opacity: o, transform: 'translateY(0)' }, { opacity: 0, transform: reduce ? 'translateY(0)' : 'translateY(-.5em)' }], { duration: 400, easing: EASE, fill: 'forwards' })
  }
  cancelAnims(ST.bloom)
  ST.bloom.style.opacity = 0.85
  ST.bloom.animate([{ opacity: 0 }, { opacity: 0.85 }], { duration: dur, easing: EASE })
  const cur = S.second ? ST.B : ST.A
  cur.children[1].animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: EASE, fill: 'forwards' })
  if (!reduce) ST.slots.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }], { duration: dur, easing: EASE, fill: 'forwards' })
  if (desk() && !reduce) ST.frame.animate([{ transform: 'translateX(0)', opacity: 1 }, { opacity: 0.9, offset: 0.55 }, { transform: `translateX(${dir * -26}px)`, opacity: 0 }], { duration: dur, easing: EASE, fill: 'forwards' })
  await wait(dur, r)
}

function revealNext () {
  if (S.shown >= S.total || current !== 'story') return
  clearAuto(); hideTap()
  const k = S.shown++
  const sc = content.scenes[S.i]
  const ps = $$('.line', ST.lines)
  ps.forEach((p, j) => p.classList.toggle('past', j < k))
  const p = ps[k]
  if (!p) return
  p.classList.add('on')
  if (k === switchAt(sc) && sc.photos[1]) secondPhoto(true)
  const look = sc.focus?.[k]
  if (look) pushIn(S.second ? ST.B : ST.A, look)
  snd.chime(S.i + k, 0.011)
  progress()
  const tok = ++S.tok, r = run
  const done = mirrored(sc, k) ? mirrorLine(p, r) : revealWords(p)
  done.then(() => {
    if (!r.alive || tok !== S.tok) return
    if (S.shown < S.total) scheduleAuto(D(1800 + 45 * p.textContent.length))
    else scheduleTap()
  })
}
async function mirrorLine (p, r) {
  if (reduce) return settle(p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'backwards' }))
  // mirror it about the words' own centre: a wrapped line is narrower than its box, and would jump sideways
  const box = p.getBoundingClientRect(), rg = document.createRange()
  rg.selectNodeContents(p)
  const tb = rg.getBoundingClientRect()
  p.style.transformOrigin = `${(tb.left + tb.width / 2 - box.left).toFixed(1)}px 50%`
  const M = 'perspective(900px) rotateY(180deg)', N = 'perspective(900px) rotateY(0deg)'
  const a1 = p.animate([{ opacity: 0, transform: M, filter: 'blur(2.5px)' }, { opacity: 1, transform: M, filter: 'blur(1.3px)' }], { duration: 450, easing: EASE, fill: 'forwards' })
  await settle(a1)
  await wait(500, r)
  const a2 = p.animate([{ transform: M, filter: 'blur(1.3px)' }, { transform: N, filter: 'blur(0px)' }], { duration: 600, easing: 'cubic-bezier(.5,.05,.25,1)', fill: 'forwards' })
  await settle(a2)
  a1.cancel(); a2.cancel()
}
function secondPhoto (on) {
  const B = ST.B, sharp = B.children[1], r = run
  if (on === S.second) return
  S.second = on
  cancelAnims(B); cancelAnims(sharp)
  const id = on ? B.dataset.id : ST.A.dataset.id
  wash(content.photos[id]?.ph)
  if (!on) { B.style.opacity = 0; B.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 300 : 900, easing: EASE }); return }
  B.style.opacity = 1; sharp.style.opacity = 1
  if (reduce) { B.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); return }
  // crossfade through its own soft layer: a slight blur, without animating a filter
  B.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, easing: EASE })
  sharp.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: 1500, easing: EASE })
  settle(B.animate([{ transform: 'scale(1.05)' }, { transform: 'scale(1.02)' }], { duration: 1500, easing: EASE, fill: 'forwards' }))
    .then(() => { if (r.alive && S.second) kenBurns(B) })
}

// "Do you love me?" comes right after scene interludeAfter (default: after the last one), once per watch
let loveSaid = false
const loveAt = () => { const a = content.interludeAfter, n = content.scenes.length; return Number.isInteger(a) && a >= 0 && a < n ? a : n - 1 }
function afterLove () { const i = loveAt() + 1; return i < content.scenes.length ? show('story', i) : show('hold') }
function forward () {
  if (S.busy || S.fog) return
  hideTap()
  if (S.shown < S.total) revealNext()
  else if (S.i === loveAt() && !loveSaid) show('interlude')
  else if (S.i < content.scenes.length - 1) playScene(S.i + 1)
  else show('hold')
}
function back () {
  if (S.busy || S.fog) return
  hideTap()
  const ps = $$('.line', ST.lines)
  if (S.shown >= 2) {
    // step back one line and replay the one before it
    clearAuto()
    const last = ps[S.shown - 1]
    cancelAnims(last); last.classList.remove('on', 'past')
    S.shown -= 2
    if (S.shown < switchAt(content.scenes[S.i]) && S.second) secondPhoto(false)
    const prev = ps[S.shown]
    cancelAnims(prev); prev.classList.remove('on', 'past')
    $$('.w', prev).forEach(cancelAnims)
    revealNext()
  } else if (S.i > 0) playScene(S.i - 1)
  else if (S.shown === 1) { clearAuto(); ps[0].classList.remove('on'); S.shown = 0; revealNext() }
}

// stage input: one pointer handler, a 300 ms guard, press-and-hold pauses
let pd = null, lastNav = -1e9, holdT = 0
ST.stage.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary || e.button > 0 || current !== 'story') return
  if (e.target.closest('button, a, input, #fog.on')) return
  pd = { x: e.clientX, y: e.clientY, id: e.pointerId }
  try { ST.stage.setPointerCapture(e.pointerId) } catch {}
  clearTimeout(holdT)
  holdT = setTimeout(() => { if (pd) holdPause(true) }, 350)
})
ST.stage.addEventListener('pointermove', (e) => {
  if (pd && e.pointerId === pd.id && Math.hypot(e.clientX - pd.x, e.clientY - pd.y) > 14) clearTimeout(holdT)
})
ST.stage.addEventListener('pointerup', (e) => {
  if (!pd || e.pointerId !== pd.id) return
  clearTimeout(holdT)
  const dx = e.clientX - pd.x, dy = e.clientY - pd.y
  pd = null
  if (S.held) { holdPause(false); return }
  snd.wake()
  const swipe = Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2
  const tap = Math.hypot(dx, dy) < 14
  if ((!swipe && !tap) || e.timeStamp - lastNav < 300) return
  lastNav = e.timeStamp
  const rtl = lang === 'fa'
  let fwd
  if (swipe) fwd = rtl ? dx > 0 : dx < 0
  else {
    const b = ST.stage.getBoundingClientRect(), fx = (e.clientX - b.left) / b.width
    fwd = rtl ? fx < 0.7 : fx > 0.3
  }
  fwd ? forward() : back()
})
ST.stage.addEventListener('pointercancel', () => { clearTimeout(holdT); pd = null; if (S.held) holdPause(false) })
ST.stage.addEventListener('contextmenu', (e) => e.preventDefault())

screens.story = {
  enter (i) { S.visible = false; playScene(i, { instant: true }) },
  leave () {
    S.visible = false; clearAuto(); hideTap(); fogStop(); if (S.held) holdPause(false)
    releaseLater('story', $$('.sharp', ST.slots)) // keep the WebView's decoded-image memory small
  },
  relang () {
    chapterText()
    buildLines(S.shown)
    ST.tap.textContent = t(content.ui.tap)
    $('span', ST.hint).textContent = t(content.ui.wipe)
    updateSkip()
  },
}

// ---------- the fog moment: breath on glass, wiped clear by hand ----------
const F = { active: false, down: null, last: null, grid: null, cols: 18, rows: 22, cells: 1, hit: 0, idle: 0, still: 0, stamp: null, R: 0, done: null, touched: false }
function cover (x, img, dw, dh, fx = 0.5, fy = 0.5, zoom = 1) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height
  if (!iw || !ih) return
  const s = Math.max(dw / iw, dh / ih) * zoom, w = iw * s, h = ih * s
  x.drawImage(img, (dw - w) * fx, (dh - h) * fy, w, h)
}
function insideArch (u, v) {
  const ry = 0.34
  if (v >= ry) return true
  const dx = (u - 0.5) / 0.5, dy = (v - ry) / ry
  return dx * dx + dy * dy <= 1
}
function drawFog (ph) {
  const c = ST.fog, rect = ST.frame.getBoundingClientRect()
  const dpr = Math.min(2, devicePixelRatio || 1)
  const W = Math.max(2, Math.round(rect.width * dpr)), H = Math.max(2, Math.round(rect.height * dpr))
  c.width = W; c.height = H
  const x = c.getContext('2d')
  x.globalCompositeOperation = 'source-over'
  const [fx, fy] = content.photos[ph.dataset.id]?.focal || [0.5, 0.5]
  const src = ph.children[1].naturalWidth ? ph.children[1] : ph.children[0]
  // the photo seen through wet glass: drawn tiny, then scaled back up (a blur every engine can do)
  const s1 = document.createElement('canvas'), s2 = document.createElement('canvas')
  s1.width = Math.max(8, Math.round(W / 18)); s1.height = Math.max(8, Math.round(H / 18))
  s2.width = s1.width * 4; s2.height = s1.height * 4
  const s1x = s1.getContext('2d'), s2x = s2.getContext('2d')
  s1x.imageSmoothingQuality = s2x.imageSmoothingQuality = x.imageSmoothingQuality = 'high'
  cover(s1x, src, s1.width, s1.height, fx, fy, 1.04)
  s2x.drawImage(s1, 0, 0, s2.width, s2.height)
  x.drawImage(s2, 0, 0, W, H)
  s1.width = s1.height = s2.width = s2.height = 0
  // warm breath: pale, thicker towards the edges
  x.fillStyle = 'rgba(243,234,221,.56)'
  x.fillRect(0, 0, W, H)
  const g = x.createRadialGradient(W * 0.5, H * 0.6, 0, W * 0.5, H * 0.6, Math.max(W, H) * 0.72)
  g.addColorStop(0, 'rgba(255,250,242,.08)')
  g.addColorStop(0.65, 'rgba(248,240,228,.1)')
  g.addColorStop(1, 'rgba(232,220,204,.32)')
  x.fillStyle = g
  x.fillRect(0, 0, W, H)
  // condensation: a fine speckle and a few beads of water
  for (let n = 0; n < 1400; n++) {
    const s = (Math.random() * 1.1 + 0.4) * dpr
    x.fillStyle = `rgba(255,255,255,${(Math.random() * 0.22).toFixed(3)})`
    x.fillRect(Math.random() * W, Math.random() * H, s, s)
  }
  for (let n = 0; n < 55; n++) {
    const px = Math.random() * W, py = H * (0.25 + Math.random() * 0.75), rr = (1 + Math.random() * 2.2) * dpr
    const b = x.createRadialGradient(px - rr * 0.35, py - rr * 0.35, 0, px, py, rr)
    b.addColorStop(0, 'rgba(255,255,255,.75)')
    b.addColorStop(0.55, 'rgba(255,252,246,.25)')
    b.addColorStop(1, 'rgba(120,100,80,.18)')
    x.fillStyle = b
    x.beginPath(); x.arc(px, py, rr, 0, Math.PI * 2); x.fill()
  }
  // the brush: a fingertip, soft at the edges
  F.R = 25 * dpr
  const st = document.createElement('canvas')
  st.width = st.height = Math.ceil(F.R * 2)
  const sx = st.getContext('2d'), sg = sx.createRadialGradient(F.R, F.R, 0, F.R, F.R, F.R)
  sg.addColorStop(0, 'rgba(0,0,0,1)'); sg.addColorStop(0.5, 'rgba(0,0,0,.9)'); sg.addColorStop(0.8, 'rgba(0,0,0,.35)'); sg.addColorStop(1, 'rgba(0,0,0,0)')
  sx.fillStyle = sg
  sx.fillRect(0, 0, st.width, st.height)
  F.stamp = st
  F.grid = new Uint8Array(F.cols * F.rows)
  F.cells = 0; F.hit = 0
  for (let rr = 0; rr < F.rows; rr++) {
    for (let cc = 0; cc < F.cols; cc++) {
      const inside = insideArch((cc + 0.5) / F.cols, (rr + 0.5) / F.rows)
      F.grid[rr * F.cols + cc] = inside ? 0 : 2
      if (inside) F.cells++
    }
  }
}
function stampAt (px, py) {
  const c = ST.fog, x = c.getContext('2d')
  x.globalCompositeOperation = 'destination-out'
  x.drawImage(F.stamp, px - F.R, py - F.R)
  const W = c.width, H = c.height, rr = F.R * 0.85 // about where the glass actually looks clear
  const c0 = Math.max(0, Math.floor(((px - rr) / W) * F.cols)), c1 = Math.min(F.cols - 1, Math.floor(((px + rr) / W) * F.cols))
  const r0 = Math.max(0, Math.floor(((py - rr) / H) * F.rows)), r1 = Math.min(F.rows - 1, Math.floor(((py + rr) / H) * F.rows))
  for (let r = r0; r <= r1; r++) {
    for (let cc = c0; cc <= c1; cc++) {
      const k = r * F.cols + cc
      if (F.grid[k]) continue
      const cx = ((cc + 0.5) / F.cols) * W, cy = ((r + 0.5) / F.rows) * H
      if ((cx - px) ** 2 + (cy - py) ** 2 <= rr * rr) { F.grid[k] = 1; F.hit++ }
    }
  }
}
function fogPt (e) {
  const b = ST.fog.getBoundingClientRect()
  return { x: (e.clientX - b.left) * (ST.fog.width / b.width), y: (e.clientY - b.top) * (ST.fog.height / b.height), t: e.timeStamp }
}
function strokeTo (p) {
  const l = F.last
  const d = Math.hypot(p.x - l.x, p.y - l.y), n = Math.max(1, Math.ceil(d / (F.R * 0.22)))
  for (let k = 1; k <= n; k++) stampAt(l.x + ((p.x - l.x) * k) / n, l.y + ((p.y - l.y) * k) / n)
  F.last = p
}
function armIdle () { clearTimeout(F.idle); F.idle = setTimeout(melt, 7000) }
function melt () {
  if (!F.active) return
  F.active = false
  clearTimeout(F.idle)
  snd.wipeEnd()
  ST.hint.classList.remove('on')
  ST.fog.classList.remove('on')
  cancelAnims(ST.fog)
  ST.fog.style.opacity = 0
  ST.fog.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 300 : 1400, easing: 'cubic-bezier(.4,0,.2,1)' })
  snd.chime(2, 0.022)
  const done = F.done
  F.done = null
  setTimeout(() => done?.(), reduce ? 300 : 650)
}
function fogStop () {
  F.active = false; F.done = null; F.down = null
  clearTimeout(F.idle); clearTimeout(F.still)
  snd.wipeEnd()
  ST.fog.classList.remove('on')
  ST.hint.classList.remove('on')
  cancelAnims(ST.fog)
  ST.fog.style.opacity = 0
}
async function fogScene (r) {
  const ph = ST.A, sharp = ph.children[1]
  cancelAnims(sharp); sharp.style.opacity = 1
  ph.style.transform = 'scale(1.02)'
  drawFog(ph)
  $('span', ST.hint).textContent = t(content.ui.wipe)
  ST.fog.style.opacity = 1
  ST.fog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 300 : 700, easing: EASE })
  fadeTo(ST.bloom, 0, 1200)
  ST.fog.classList.add('on')
  ST.hint.classList.add('on')
  F.active = true; F.touched = false; F.down = null
  S.fog = true; S.busy = false
  armIdle()
  await new Promise((res) => { F.done = res })
  if (!r.alive) return
  S.fog = false
  kenBurns(ph)
}
ST.fog.addEventListener('pointerdown', (e) => {
  if (!F.active || F.down != null) return
  e.preventDefault()
  try { ST.fog.setPointerCapture(e.pointerId) } catch {}
  F.down = e.pointerId
  clearTimeout(F.idle)
  if (!F.touched) { F.touched = true; ST.hint.classList.remove('on'); vibrate(6) }
  snd.wipeStart()
  F.last = fogPt(e)
  stampAt(F.last.x, F.last.y)
})
ST.fog.addEventListener('pointermove', (e) => {
  if (F.down !== e.pointerId || !F.active) return
  const t0 = F.last.t, x0 = F.last.x, y0 = F.last.y
  const list = e.getCoalescedEvents?.()
  for (const ev of list && list.length ? list : [e]) strokeTo(fogPt(ev))
  const dpr = ST.fog.width / ST.fog.getBoundingClientRect().width
  const v = Math.hypot(F.last.x - x0, F.last.y - y0) / dpr / Math.max(8, e.timeStamp - t0)
  snd.wipeSpeed(v)
  clearTimeout(F.still)
  F.still = setTimeout(() => snd.wipeSpeed(0), 90)
  if (F.hit / F.cells >= 0.45) melt()
})
const fogUp = (e) => {
  if (F.down !== e.pointerId) return
  F.down = null
  snd.wipeEnd()
  if (!F.active) return
  // a real window has been wiped in it and the finger lifted: the rest of the breath clears on its own soon
  if (F.hit / F.cells >= 0.25) { clearTimeout(F.idle); F.idle = setTimeout(melt, D(2400)) }
  else armIdle()
}
ST.fog.addEventListener('pointerup', fogUp)
ST.fog.addEventListener('pointercancel', fogUp)

// =====================================================================
// INTERLUDE: "Do you love me?"
// =====================================================================
const IL = { el: $('#s-interlude'), label: $('.il-label'), q: $('.il-q'), yes: $('#yes'), no: $('#no'), slot: $('.noslot'), answers: $('.answers'), after: $('.il-after'), cont: $('.il-cont'), arena: $('.arena'), shards: $('.shards') }
const I = { n: 0, ns: 1, ys: 1, final: false, justFinal: false, done: false, last: 0, prevD: 1e9 }
function renderIL () {
  const c = content.interlude
  IL.label.textContent = t(c.label)
  splitWords(IL.q, t(c.question))
  $('span', IL.yes).textContent = t(c.yes)
  $('span', IL.no).textContent = I.final ? t(c.noFinal) : tl(c.no)[Math.min(I.n, tl(c.no).length - 1)] || ''
  $('span', IL.cont).textContent = t(content.ui.continue)
  if (I.done) {
    const keep = $$('.line.on', IL.after).length, finished = IL.cont.classList.contains('on')
    IL.after.textContent = ''
    tl(c.afterYes).forEach((l, k) => {
      const p = mkLine(l)
      if (k < keep) p.classList.add('on')
      if (k < keep - 1 && !finished) p.classList.add('past')
      IL.after.append(p)
    })
  }
}
screens.interlude = {
  async enter (arg, { r }) {
    Object.assign(I, { n: 0, ns: 1, ys: 1, final: false, justFinal: false, done: false, last: 0, prevD: 1e9 })
    for (const el of [IL.label, IL.q, IL.answers, IL.yes, IL.no]) { cancelAnims(el); el.style.opacity = ''; el.style.transform = '' }
    IL.no.classList.remove('final')
    IL.label.hidden = IL.q.hidden = IL.answers.hidden = false
    IL.after.textContent = ''
    IL.cont.classList.remove('on')
    renderIL()
    snd.musicTo(0.35, 1.6)
    orsi('warm')
    const prev = content.scenes[loveAt()]
    wash(content.photos[prev.photos[prev.photos.length - 1]]?.ph); washDim(0.55)
    document.addEventListener('pointermove', ilMove)
    if (reduce) return
    IL.label.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: EASE, fill: 'backwards' })
    revealWords(IL.q, { delay: 350, dur: 900, stagger: 90, blur: 8 })
    IL.answers.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1100, delay: 1100, easing: EASE, fill: 'backwards' })
  },
  leave () { document.removeEventListener('pointermove', ilMove); snd.musicTo(0.55, 2) },
  relang: renderIL,
}
function noBase () {
  const s = IL.slot.getBoundingClientRect()
  return { x: lang === 'fa' ? s.right - IL.no.offsetWidth : s.left, y: s.top }
}
function placeNo (fx, fy) {
  const a = IL.arena.getBoundingClientRect()
  const w = IL.no.offsetWidth * I.ns, h = IL.no.offsetHeight * I.ns
  // Yes's final rect: its untransformed box (.answers wraps exactly it) grown about its origin (50% 20%)
  const yb = IL.answers.getBoundingClientRect(), s = I.ys, pad = 20
  const ox = yb.left + yb.width * 0.5, oy = yb.top + yb.height * 0.2
  const ycx = ox, ycy = yb.top + yb.height * 0.5
  const avoid = [{ l: ox - yb.width * 0.5 * s - pad, r: ox + yb.width * 0.5 * s + pad, t: oy - yb.height * 0.2 * s - pad, b: oy + yb.height * 0.8 * s + pad }]
  for (const el of [IL.q, IL.label, $('#chrome')]) { const b = el.getBoundingClientRect(); avoid.push({ l: b.left - 12, r: b.right + 12, t: b.top - 12, b: b.bottom + 12 }) }
  const clear = (x, y) => avoid.every((o) => x + w < o.l || x > o.r || y + h < o.t || y > o.b)
  const cur = IL.no.getBoundingClientRect()
  const cands = []
  for (let k = 0; k < 60 && cands.length < 14; k++) {
    const x = a.left + Math.random() * Math.max(0, a.width - w), y = a.top + Math.random() * Math.max(0, a.height - h)
    if (!clear(x, y) || Math.hypot(x + w / 2 - fx, y + h / 2 - fy) < 120) continue
    cands.push({ x, y, d: Math.hypot(x - cur.left, y - cur.top) })
  }
  let pt
  if (cands.length) {
    // early on it bolts across the screen; as it tires, the hops get shorter
    cands.sort((p, q) => p.d - q.d)
    const tired = Math.min(1, I.n / 9)
    pt = cands[Math.round((1 - tired) * (cands.length - 1))]
  } else {
    const corners = [[a.left, a.top], [a.right - w, a.top], [a.left, a.bottom - h], [a.right - w, a.bottom - h]].filter(([x, y]) => clear(x, y))
    corners.sort((p, q) => Math.hypot(q[0] - ycx, q[1] - ycy) - Math.hypot(p[0] - ycx, p[1] - ycy))
    const [x, y] = corners[0] || [a.left, a.bottom - h]
    pt = { x, y }
  }
  const base = noBase()
  IL.no.style.transform = `translate(${(pt.x - base.x).toFixed(1)}px, ${(pt.y - base.y).toFixed(1)}px) scale(${I.ns.toFixed(3)})`
  if (!reduce) IL.no.animate([{ opacity: 1 }, { opacity: 0.45, offset: 0.4 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' })
}
function ghostNo (b) {
  if (reduce) return
  const g = document.createElement('span')
  g.className = 'ghostno'
  g.dir = 'auto'
  g.textContent = IL.no.textContent
  g.style.transform = `translate(${b.left}px, ${b.top}px) scale(${I.ns})`
  IL.el.append(g)
  g.animate([{ opacity: 0.55, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(3px)' }], { duration: 700, easing: EASE }).finished.then(() => g.remove(), () => g.remove())
}
function flee (px, py) {
  if (I.done || I.final || current !== 'interlude') return
  const now = performance.now()
  if (now - I.last < 160) return
  I.last = now
  I.prevD = 1e9
  const labels = tl(content.interlude.no)
  const b = IL.no.getBoundingClientRect()
  I.n++
  if (I.n >= labels.length) {
    // out of excuses: it stays, and becomes a yes
    I.final = true; I.justFinal = true
    $('span', IL.no).textContent = t(content.interlude.noFinal)
    IL.no.classList.add('final')
    snd.chime(4, 0.03)
    return
  }
  ghostNo(b)
  $('span', IL.no).textContent = labels[I.n]
  I.ns = Math.max(0.7, I.ns * 0.93)
  I.ys = Math.min(1.85, I.ys * 1.1)
  IL.yes.style.transform = `scale(${I.ys.toFixed(3)})`
  snd.bloop(I.n)
  vibrate(12)
  placeNo(px ?? b.left + b.width / 2, py ?? b.top + b.height / 2)
}
function ilMove (e) {
  if (e.pointerType !== 'mouse' || current !== 'interlude' || I.done || I.final) return
  const b = IL.no.getBoundingClientRect()
  const dx = Math.max(b.left - e.clientX, 0, e.clientX - b.right), dy = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom)
  const d = Math.hypot(dx, dy)
  // only a cursor that is really approaching (not one that jumped there) scares it away
  if (d < 60 && I.prevD < 220 && I.prevD > d) flee(e.clientX, e.clientY)
  else I.prevD = d
}
IL.no.addEventListener('pointerdown', (e) => {
  if (I.final || I.done) return
  e.preventDefault()
  flee(e.clientX, e.clientY)
})
IL.no.addEventListener('click', (e) => {
  e.preventDefault()
  if (I.done) return
  if (e.detail === 0) { // keyboard: it escapes the same way and hands focus to Yes
    if (I.final) return sayYes()
    flee()
    I.justFinal = false
    if (!I.final) IL.yes.focus()
    return
  }
  if (I.final && !I.justFinal) sayYes()
  I.justFinal = false
})
IL.yes.addEventListener('click', () => sayYes())
function shards () {
  if (reduce) return
  const yr = IL.yes.getBoundingClientRect(), cx = yr.left + yr.width / 2, cy = yr.top + yr.height * 0.45
  const cols = ['#b8324a', '#e3a03a', '#2c58a8', '#2aa198', '#f2d49c', '#c8558a']
  const n = 15
  for (let k = 0; k < n; k++) {
    const s = document.createElement('div'), i = document.createElement('i')
    const w = 13 + Math.random() * 13
    s.className = 'shard'
    s.style.width = `${w.toFixed(1)}px`; s.style.height = `${(w * 1.3).toFixed(1)}px`
    i.style.background = cols[k % cols.length]
    i.style.filter = `blur(${(1.6 + Math.random() * 2.4).toFixed(1)}px)` // static; only the wrapper moves
    s.append(i)
    IL.shards.append(s)
    // panes of coloured light drifting slowly outwards and a little upwards, like sun through glass
    const ang = (k / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5, dist = 70 + Math.random() * 120
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist * 0.75 - 40 - Math.random() * 30, rot = (Math.random() - 0.5) * 24
    s.animate([
      { transform: `translate(${(cx - w / 2).toFixed(1)}px, ${cy.toFixed(1)}px) rotate(0deg) scale(.6)`, opacity: 0 },
      { opacity: 0.9, offset: 0.22 },
      { transform: `translate(${(cx - w / 2 + dx).toFixed(1)}px, ${(cy + dy).toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(1)`, opacity: 0 },
    ], { duration: 1700 + Math.random() * 400, easing: 'cubic-bezier(.16,.55,.3,1)', fill: 'forwards' }).finished.then(() => s.remove(), () => s.remove())
  }
}
async function sayYes () {
  if (I.done || current !== 'interlude') return
  I.done = true
  loveSaid = true
  const r = run
  snd.swell()
  snd.musicTo(0.7, 1.4)
  later(() => snd.musicTo(0.55, 5), 4200, r)
  vibrate([12, 60, 18])
  shards()
  for (const el of [IL.label, IL.q, IL.answers]) {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 300 : 800, delay: reduce ? 0 : 250, easing: EASE, fill: 'forwards' })
  }
  await wait(reduce ? 350 : 1150, r)
  IL.label.hidden = IL.q.hidden = IL.answers.hidden = true
  // all lines are laid out (hidden) up front, so nothing shifts as they arrive
  IL.after.textContent = ''
  tl(content.interlude.afterYes).forEach((l) => IL.after.append(mkLine(l)))
  const count = IL.after.children.length
  for (let k = 0; k < count; k++) {
    const ps = $$('.line', IL.after) // live: the language toggle may have rebuilt them
    ps.forEach((q, j) => q.classList.toggle('past', j < k))
    ps[k].classList.add('on')
    snd.chime(k + 2, 0.014)
    await revealWords(ps[k])
    if (!r.alive) return
    await waitTap(D(900 + 30 * ps[k].textContent.length), r)
  }
  $$('.line', IL.after).forEach((q) => q.classList.remove('past'))
  IL.cont.classList.add('on')
}
IL.cont.addEventListener('click', () => { if (current === 'interlude' && I.done) afterLove() })
IL.el.addEventListener('click', (e) => { if (current === 'interlude' && I.done && !e.target.closest('button')) skipper?.() })

// =====================================================================
// HOLD MY HAND
// =====================================================================
const HD = { el: $('#s-hold'), frame: $('#s-hold .frame'), ph: $('#s-hold .ph'), haze: $('#s-hold .haze'), glow: $('#s-hold .glow'), btn: $('#hold'), prog: $('#hold .prog'), prompt: $('.hold-prompt'), lines: $('.hold-lines') }
const CIRC = 2 * Math.PI * 30
const H = { down: false, done: false, beat: 0, anim: null }
function renderHold () {
  HD.prompt.textContent = t(content.hold.prompt)
  HD.btn.setAttribute('aria-label', t(content.hold.prompt))
  const keep = $$('.line.on', HD.lines).length
  HD.lines.textContent = ''
  tl(content.hold.lines).forEach((l, k) => { const p = mkLine(l); if (k < keep) p.classList.add('on'); HD.lines.append(p) })
}
screens.hold = {
  async enter (arg, { r }) {
    H.down = false; H.done = false; stopBeat()
    const id = content.hold.photo, meta = content.photos[id]
    const [fx, fy] = meta.focal || [0.5, 0.5]
    HD.frame.style.setProperty('--fx', fx); HD.frame.style.setProperty('--fy', fy)
    HD.glow.style.setProperty('--gx', `${fx * 100}%`); HD.glow.style.setProperty('--gy', `${fy * 100}%`)
    slotSet(HD.ph, id, t(content.hold.prompt))
    HD.btn.classList.remove('held', 'done')
    cancelAnims(HD.btn); cancelAnims(HD.prog); cancelAnims(HD.glow); cancelAnims(HD.prompt)
    HD.prog.style.strokeDashoffset = CIRC
    HD.glow.style.opacity = 0
    HD.prompt.style.opacity = ''
    HD.lines.textContent = ''
    renderHold()
    wash(meta.ph); washDim(0.9); orsi('faint')
    cancelAnims(HD.haze); HD.haze.style.opacity = 0.6
    const p = await photo(id).catch(() => null)
    if (!r.alive) return
    if (p) await setImg(HD.ph.children[1], p.url)
    if (!r.alive) return
    develop(HD.ph, HD.haze, null, r)
    if (!reduce) HD.btn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1200, delay: 900, easing: EASE, fill: 'backwards' })
  },
  leave () { holdEnd(); stopBeat(); snd.musicTo(0.55, 1.5); releaseLater('hold', [HD.ph.children[1]]) },
  relang: renderHold,
}
const dash = () => parseFloat(getComputedStyle(HD.prog).strokeDashoffset) || CIRC
function stopBeat () { clearInterval(H.beat); H.beat = 0 }
function beat () {
  snd.heartbeat()
  vibrate([18])
  if (!reduce) HD.btn.querySelector('.dot').animate([{ transform: 'scale(.8)' }, { transform: 'scale(1.12)', offset: 0.18 }, { transform: 'scale(.8)' }], { duration: 520, easing: 'ease-out' })
}
function holdStart (e) {
  if (H.done || H.down || current !== 'hold') return
  H.down = true
  snd.wake()
  if (e?.pointerId != null) { try { HD.btn.setPointerCapture(e.pointerId) } catch {} }
  HD.btn.classList.add('held')
  const from = dash()
  cancelAnims(HD.prog)
  HD.prog.style.strokeDashoffset = 0
  H.anim = HD.prog.animate([{ strokeDashoffset: from }, { strokeDashoffset: 0 }], { duration: Math.max(60, 1800 * (from / CIRC)), easing: 'linear' })
  H.anim.finished.then(() => { if (H.down && !H.done) holdDone() }, () => {})
  const g0 = +getComputedStyle(HD.glow).opacity
  cancelAnims(HD.glow); HD.glow.style.opacity = 0.5
  HD.glow.animate([{ opacity: g0 }, { opacity: 0.5 }], { duration: 1800 * (from / CIRC), easing: 'ease-in' })
  snd.musicTo(0.63, 1.2)
  beat()
  stopBeat()
  H.beat = setInterval(beat, 800)
}
function holdEnd () {
  if (!H.down) return
  H.down = false
  stopBeat()
  HD.btn.classList.remove('held')
  if (H.done) return
  // lifted early: the ring drains back and nothing breaks
  const from = dash()
  cancelAnims(HD.prog)
  HD.prog.style.strokeDashoffset = CIRC
  HD.prog.animate([{ strokeDashoffset: from }, { strokeDashoffset: CIRC }], { duration: 160 + 520 * (1 - from / CIRC), easing: EASE })
  fadeTo(HD.glow, 0, 700)
  snd.musicTo(0.55, 0.8)
}
async function holdDone () {
  H.done = true; H.down = false
  stopBeat()
  const r = run
  HD.btn.classList.remove('held'); HD.btn.classList.add('done')
  vibrate([20, 70, 20])
  snd.chime(0, 0.04); snd.chime(3, 0.03, 0.14); snd.chime(7, 0.02, 0.3)
  snd.musicTo(0.55, 3)
  if (!reduce) HD.btn.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 1200, easing: EASE, fill: 'forwards' })
  else HD.btn.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' })
  fadeTo(HD.glow, 0.32, 2400)
  HD.prompt.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: EASE, fill: 'forwards' })
  const count = $$('.line', HD.lines).length
  await wait(count ? 650 : 1500, r) // no lines: let the held hand linger a moment, then the letter
  for (let k = 0; k < count; k++) {
    const p = $$('.line', HD.lines)[k] // live: the language toggle may have rebuilt them
    p.classList.add('on')
    snd.chime(k + 1, 0.012)
    await revealWords(p)
    if (!r.alive) return
    await waitTap(D(k === count - 1 ? 2600 : 900 + 30 * p.textContent.length), r)
  }
  show('letter')
}
HD.btn.addEventListener('pointerdown', (e) => { e.preventDefault(); holdStart(e) })
HD.btn.addEventListener('pointerup', holdEnd)
HD.btn.addEventListener('pointercancel', holdEnd)
HD.btn.addEventListener('lostpointercapture', holdEnd)
HD.btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdStart() } })
HD.btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') holdEnd() })
HD.el.addEventListener('contextmenu', (e) => e.preventDefault())
HD.el.addEventListener('click', (e) => { if (current === 'hold' && H.done && !e.target.closest('button')) skipper?.() })

// =====================================================================
// LETTER
// =====================================================================
const LT = { el: $('#s-letter'), sheet: $('#letter'), ink: $('#letter .ink'), cont: $('.l-cont') }
function paperTexture () {
  const S = 256, c = document.createElement('canvas')
  c.width = c.height = S
  const x = c.getContext('2d')
  x.fillStyle = '#efe4d3'
  x.fillRect(0, 0, S, S)
  for (let k = 0; k < 9; k++) {
    const px = Math.random() * S, py = Math.random() * S, rr = 30 + Math.random() * 70
    const g = x.createRadialGradient(px, py, 0, px, py, rr)
    g.addColorStop(0, `rgba(${Math.random() < 0.5 ? '170,130,85' : '255,250,240'},.05)`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    x.fillStyle = g
    x.fillRect(0, 0, S, S)
  }
  x.lineWidth = 0.6
  for (let k = 0; k < 260; k++) {
    const px = Math.random() * S, py = Math.random() * S, a = Math.random() * Math.PI, l = 3 + Math.random() * 10
    x.strokeStyle = `rgba(${Math.random() < 0.7 ? '120,90,60' : '255,255,255'},${(0.04 + Math.random() * 0.07).toFixed(3)})`
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke()
  }
  const d = x.getImageData(0, 0, S, S)
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 12
    d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n
  }
  x.putImageData(d, 0, 0)
  LT.sheet.style.setProperty('--paper-tex', `url(${c.toDataURL('image/jpeg', 0.9)})`)
  c.width = c.height = 0
}
function drawEmboss (svg) {
  const NS = 'http://www.w3.org/2000/svg'
  const ds = ['M8 80A72 72 0 0 1 152 80', 'M62 80A18 18 0 0 1 98 80', 'M34 80A46 46 0 0 1 126 80', 'M4 80H156']
  for (let k = 1; k < 8; k++) {
    const a = (k * Math.PI) / 8
    ds.push(`M${(80 + 18 * Math.cos(a)).toFixed(2)} ${(80 - 18 * Math.sin(a)).toFixed(2)}L${(80 + 72 * Math.cos(a)).toFixed(2)} ${(80 - 72 * Math.sin(a)).toFixed(2)}`)
  }
  for (const d of ds) {
    for (const [cls, off] of [['hi', 0.9], ['lo', 0]]) {
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', d); p.setAttribute('class', cls)
      if (off) p.setAttribute('transform', `translate(${off} ${off})`)
      svg.append(p)
    }
  }
}
function renderLetter () {
  LT.ink.textContent = ''
  for (const para of tl(content.finale.letter)) { const p = document.createElement('p'); p.dir = 'auto'; p.textContent = para; LT.ink.append(p) }
  const s = document.createElement('p'); s.className = 'signoff'; s.dir = 'auto'; s.textContent = t(content.finale.signoff)
  LT.ink.append(s)
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path')
  svg.setAttribute('class', 'flourish'); svg.setAttribute('viewBox', '0 0 120 18'); svg.setAttribute('aria-hidden', 'true')
  path.setAttribute('d', 'M4 11c10-5 19-6 28-2s16 6 26 1 17-7 27-3 15 5 31-1')
  svg.append(path)
  LT.ink.append(svg)
  $('span', LT.cont).textContent = t(content.ui.continue)
}
screens.letter = {
  async enter (arg, { r }) {
    renderLetter()
    LT.cont.classList.remove('on')
    LT.ink.scrollTop = 0
    orsi('faint'); washDim(0.6)
    snd.paper()
    cancelAnims(LT.sheet); cancelAnims(LT.ink)
    if (reduce) LT.sheet.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 })
    else {
      LT.sheet.animate([{ transform: 'translateY(55vh)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1, offset: 0.7 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 1100, easing: EASE })
      LT.ink.animate([{ filter: 'blur(6px)' }, { filter: 'blur(0px)' }], { duration: 900, easing: EASE, fill: 'backwards' })
    }
    const kids = [...LT.ink.children]
    kids.forEach((p, k) => {
      if (reduce) return
      if (p.tagName === 'svg') return
      p.animate([{ opacity: 0, transform: 'translateY(.35em)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 1100, delay: 700 + k * 420, easing: EASE, fill: 'backwards' })
    })
    const fl = $('path', $('.flourish', LT.ink))
    const len = 128
    fl.style.strokeDasharray = len
    if (!reduce) fl.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1400, delay: 900 + kids.length * 420, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'backwards' })
    await wait((reduce ? 600 : 1200 + kids.length * 420) + D(1800), r)
    LT.cont.classList.add('on')
  },
  relang () { const on = LT.cont.classList.contains('on'); renderLetter(); LT.cont.classList.toggle('on', on) },
}
LT.cont.addEventListener('click', () => { if (current === 'letter') show('credits') })

// =====================================================================
// CREDITS
// =====================================================================
const CR = { el: $('#s-credits'), roll: $('#credits .roll'), end: $('.end'), anim: null }
function renderCredits () {
  CR.roll.textContent = ''
  const list = tl(content.credits)
  for (let k = 0; k < list.length; k += 2) {
    const b = setText(document.createElement('p'), list[k + 1] || '')
    if (!list[k]) { b.className = 'cr-close'; CR.roll.append(b); continue } // no role: a closing line
    const a = document.createElement('p'); a.className = 'label cr-role'; a.dir = 'auto'; a.textContent = list[k]
    b.className = 'cr-name'
    CR.roll.append(a, b)
  }
  // the closing verse, then the end line
  const c = content.coda
  $('.coda').hidden = !c
  if (c) {
    $('#coda-v').textContent = c.fa
    $('#coda-poet').textContent = t(c.poet)
    $('#coda-en').textContent = lang === 'en' ? c.en : ''
  }
  $('.theend').textContent = t(content.ui.theEnd)
  $('#to-gallery span').textContent = t(content.ui.toGallery)
  $('#again span').textContent = t(content.ui.again)
}
function creditsEnd () {
  CR.end.classList.add('on')
  seen = true
  store.set('lg-seen', '1')
}
screens.credits = {
  async enter (arg, { r }) {
    renderCredits()
    CR.end.classList.remove('on')
    CR.anim?.cancel(); cancelAnims(CR.roll)
    CR.roll.style.opacity = CR.roll.style.transform = ''
    orsi('faint'); washDim(0.22)
    $('#vignette').style.opacity = 0.7
    await wait(60, r)
    if (reduce) { // no roll: a few credits at a time, each page centred and crossfaded
      const units = [], vh = innerHeight
      for (const el of CR.roll.children) { if (el.classList.contains('cr-name')) units[units.length - 1].push(el); else units.push([el]) }
      let page = []
      const pages = [page]
      for (const u of units) {
        const top = (page[0] || u[0]).offsetTop, end = u[u.length - 1]
        if (page.length && (end.offsetTop + end.offsetHeight - top > vh * 0.58 || u[0].classList.contains('cr-close'))) pages.push(page = [])
        page.push(...u)
      }
      for (const p of pages) {
        CR.roll.style.opacity = 0
        // only this page is laid out (display, not visibility: a hidden block can leave its isolated runs painted)
        for (const el of CR.roll.children) el.hidden = !p.includes(el)
        const mid = (p[0].offsetTop + p[p.length - 1].offsetTop + p[p.length - 1].offsetHeight) / 2
        CR.roll.style.transform = `translateY(${(vh / 2 - mid).toFixed(1)}px)`
        settle(fadeTo(CR.roll, 1, 300))
        await wait(D(4200), r)
        settle(fadeTo(CR.roll, 0, 300))
        await wait(320, r)
      }
      creditsEnd()
      return
    }
    // a steady roll that slows to a stop with the closing line in the middle of the screen (or rolls off without one)
    const vh = innerHeight, h = CR.roll.offsetHeight, close = $('.cr-close', CR.roll)
    const y1 = close ? vh / 2 - (close.offsetTop + close.offsetHeight / 2) : -h
    const speed = 0.07 // px per ms; the ease-out tail starts at this speed (a quadratic ease-out leaves at twice its mean)
    const tail = close ? 2600 : 0, tailD = (speed * tail) / 2, run1 = (vh - y1 - tailD) / speed
    const kf = [{ transform: `translateY(${vh}px)`, easing: 'linear' }, { transform: `translateY(${y1 + tailD}px)`, offset: run1 / (run1 + tail), easing: 'cubic-bezier(.33,.67,.67,1)' }, { transform: `translateY(${y1}px)` }]
    if (!close) kf.splice(1, 1)
    CR.anim = CR.roll.animate(kf, { duration: D(run1 + tail), fill: 'forwards' })
    const a = CR.anim
    await settle(a)
    if (!r.alive || a.playState !== 'finished') return
    CR.anim = null // done: a tap on the end card must not pause/replay (and so rewind) the roll
    if (close) {
      await wait(D(2400), r) // let it be read, then it gives way to the end card
      CR.roll.style.transform = `translateY(${y1}px)` // stays put: the fade cancels the roll animation
      fadeTo(CR.roll, 0, 1000)
      await wait(500, r)
    }
    creditsEnd()
  },
  leave () { CR.anim?.cancel(); CR.anim = null; cancelAnims(CR.roll); CR.roll.style.opacity = CR.roll.style.transform = ''; $('#vignette').style.opacity = '' },
  // the roll's stopping point and pages are measured per language: mid-roll, start it again in hers
  relang () { if (CR.end.classList.contains('on')) renderCredits(); else show('credits', 0, { instant: true }) },
}
CR.el.addEventListener('pointerdown', (e) => { if (current === 'credits' && !e.target.closest('button')) CR.anim?.pause() })
const crResume = () => { if (current === 'credits' && CR.anim?.playState === 'paused' && !document.hidden) CR.anim.play() }
CR.el.addEventListener('pointerup', crResume)
CR.el.addEventListener('pointercancel', crResume)
CR.el.addEventListener('pointerleave', crResume)
$('#to-gallery').addEventListener('click', () => show('gallery'))
$('#again').addEventListener('click', () => show('opening'))

// =====================================================================
// chrome, keys, visibility
// =====================================================================
$('#mute').addEventListener('click', () => {
  const m = !snd.isMuted()
  snd.setMuted(m)
  store.set('lg-mute', m ? '1' : '0')
  $('#mute').setAttribute('aria-pressed', String(m))
})
$('#lang').addEventListener('click', () => {
  setLang(lang === 'fa' ? 'en' : 'fa')
  store.set('lg-lang', lang)
  if (lock) renderGate()
  if (content && current !== 'gate') screens[current]?.relang?.()
})
$('#skip').addEventListener('click', () => { if (content) show('gallery') })
document.addEventListener('pointerup', () => snd.wake(), { passive: true })
document.addEventListener('keydown', (e) => {
  if (!content) return
  snd.wake()
  if (e.key === 'Escape' && current === 'gallery') return screens.gallery?.key?.(e)
  if (e.target.closest?.('input, textarea')) return
  const onButton = e.target.closest?.('button')
  const rtl = lang === 'fa'
  const fwdKey = rtl ? 'ArrowLeft' : 'ArrowRight', backKey = rtl ? 'ArrowRight' : 'ArrowLeft'
  if (current === 'story') {
    if ((e.key === ' ' && !onButton) || e.key === fwdKey) {
      e.preventDefault()
      if (e.timeStamp - lastNav < 300) return
      lastNav = e.timeStamp
      forward()
    } else if (e.key === backKey) {
      e.preventDefault()
      if (e.timeStamp - lastNav < 300) return
      lastNav = e.timeStamp
      back()
    }
  } else if (current === 'opening' && !onButton && (e.key === ' ' || e.key === fwdKey)) {
    e.preventDefault()
    if (O.stage === 2) beginStory()
    else skipper?.()
  } else if (current === 'gallery') screens.gallery?.key?.(e)
})
document.addEventListener('visibilitychange', () => {
  if (current === 'story') pauseAuto(document.hidden || S.held)
  if (current === 'credits') { if (document.hidden) CR.anim?.pause(); else crResume() }
})

// =====================================================================
// boot
// =====================================================================
async function boot () {
  grainTile()
  paperTexture()
  drawEmboss($('.emboss'))
  const muted = store.get('lg-mute') === '1'
  snd.setInitialMute(muted)
  document.body.classList.toggle('muted', muted)
  $('#mute').setAttribute('aria-pressed', String(muted))
  setLang(params.get('lang') || store.get('lg-lang') || 'fa')
  snd.loadMusic('assets/music.m4a.txt') // ~4 MB: start now so it is here by the time the gate opens
  try {
    lock = await (await fetch('lock.json', { cache: 'no-store' })).json()
  } catch { return }
  V = versionFrom((lock.wraps || []).join('|') + (lock.salt || ''))
  const want = params.get('lang') || store.get('lg-lang') || lock.lang
  setLang(want)
  $('#s-gate').classList.add('on')
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))]) } catch {}
  bootGate()
}
boot()
