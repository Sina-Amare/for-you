// The gallery: the story photos plus whatever gets added later.
// Uploads are sealed with the same key and stored in a private GitHub repo through the Contents API.
import { seal, open, b64 } from './lock.js'

export function createGallery (A) {
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const C = A.content, GT = C.gallery, gh = C.github
  const t = A.t, tl = A.tl
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const EASE = A.EASE

  const el = $('#s-gallery'), scroller = $('.gscroll'), grid = $('.grid'), addBtn = $('#add'), off = $('.goff'), empty = $('.gempty')
  const lb = $('#lightbox'), lbStage = $('.lb-stage'), lbPh = $('.lb-ph'), lbSoft = $('.lb-ph .soft'), lbSharp = $('.lb-ph .sharp'), lbHaze = $('.lb-ph .haze')
  const lbCap = $('.lb-cap'), lbSub = $('.lb-sub'), lbDel = $('.lb-del')
  const sheet = $('.sheet'), back = $('.sheet-back'), file = $('#file'), cap = $('#caption'), send = $('#send'), status = $('.sheet-status')
  const pick = $('.pick'), prev = $('.pick-arch .prev'), pHaze = $('.pick-arch .haze'), lift = $('.pick-arch .lift')

  let paused = !gh // no repo connected (or it refused us): read-only
  let built = false, io = null, lbI = -1, lbTok = 0, picked = null, sending = false
  let by = A.store.get('lg-by') === 'me' ? 'me' : 'her'
  const items = []

  // ---------- GitHub Contents API ----------
  const path = (gh?.dir || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const api = (name = '') => `https://api.github.com/repos/${gh.repo}/contents/${path}${name ? '/' + name.split('/').map(encodeURIComponent).join('/') : ''}`
  const ref = () => `?ref=${encodeURIComponent(gh.branch || 'main')}`
  const H = (accept = 'application/vnd.github+json') => ({ Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${gh.token}` })
  let queue = Promise.resolve()
  function write (fn) { // PUT/DELETE strictly one at a time; 409 retried 3x with 800ms*n backoff
    const p = queue.then(async () => {
      for (let n = 1; ; n++) {
        const r = await fn()
        if (r.status !== 409 || n > 3) return r
        await sleep(800 * n)
      }
    })
    queue = p.catch(() => {})
    return p
  }
  const ghPut = (name, content) => write(() => fetch(api(name), {
    method: 'PUT', headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'add a memory', content, branch: gh.branch || 'main' }),
  }))
  const ghDel = (name, sha) => write(() => fetch(api(name), {
    method: 'DELETE', headers: { ...H(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'remove a memory', sha, branch: gh.branch || 'main' }),
  }))
  async function ghBytes (name) {
    // no-store: a browser's HTTP cache can keep request headers (the token) on disk
    const r = await fetch(api(name) + ref(), { headers: H('application/vnd.github.raw'), cache: 'no-store' })
    if (r.status === 401 || r.status === 403) { pause(); throw new Error('paused') }
    if (!r.ok) throw new Error('get ' + r.status)
    return r.arrayBuffer()
  }
  // An upload never changes under its name, so its sealed bytes (ciphertext only: no headers, no token) are kept
  // for the next visit. A kept copy that no longer opens (the key was rotated since) is fetched fresh.
  const shelf = (async () => { try { return await caches.open('lg-uploads') } catch { return null } })() // private windows may refuse
  const shelved = (name) => `/lg-uploads/${name}`
  async function sealed (name) {
    const c = await shelf
    try {
      const hit = await c?.match(shelved(name))
      if (hit) return await open(A.key, await hit.arrayBuffer())
    } catch {}
    const buf = await ghBytes(name)
    const bytes = await open(A.key, buf)
    c?.put(shelved(name), new Response(buf)).catch(() => {})
    return bytes
  }
  const listing = () => fetch(api() + ref(), { headers: H(), cache: 'no-store' }).then(async (r) => {
    if (r.status === 401 || r.status === 403) return 'paused'
    if (r.status === 404) return [] // nothing uploaded yet
    const l = r.ok ? await r.json() : null
    return Array.isArray(l) ? l.filter((f) => f.type === 'file' && /\.txt$/.test(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1)) : null
  }).catch(() => null)
  // Asked for at unlock: going straight to the gallery, the list and the newest thumbnails arrive behind the light.
  let early = gh ? listing() : null
  const earlyAt = Date.now(), soon = new Map() // upload name -> its small copy, already on the way
  early?.then((l) => {
    if (Array.isArray(l)) for (const f of l.slice(0, 6)) { const p = sealed('t/' + f.name); p.catch(() => {}); soon.set(f.name, p) }
  })
  function pause () {
    paused = true
    renderHead()
    if (!sheet.hidden) closeSheet()
    lbDel.hidden = true
  }

  // ---------- items ----------
  function storyItems () {
    const order = [], info = {}
    C.scenes.forEach((sc) => sc.photos.forEach((id, j) => { if (!info[id] && C.photos[id]) { info[id] = { scene: sc, j }; order.push(id) } }))
    const hp = C.hold?.photo
    if (hp && C.photos[hp] && !info[hp]) { info[hp] = { hold: true }; order.push(hp) }
    Object.keys(C.photos).sort().forEach((id) => { if (!info[id]) { info[id] = {}; order.push(id) } })
    return order.map((id) => ({ kind: 'story', id, w: C.photos[id].w, h: C.photos[id].h, ph: C.photos[id].ph, focal: C.photos[id].focal, at: C.photos[id].date, by: 'me', info: info[id] }))
  }
  function capOf (it) {
    if (it.kind === 'up') return it.caption || ''
    const f = it.info
    if (f.scene) { const ls = tl(f.scene.lines); return ls[f.j === 1 ? f.scene.switchAt ?? 2 : 0] || ls[0] || '' } // the line it arrived with
    if (f.hold) return tl(C.hold.lines).join(' ')
    return ''
  }
  function altOf (it) { return it.kind === 'story' && it.info.scene ? t(it.info.scene.label) : capOf(it) || t(GT.title) }
  function subOf (it) {
    const who = t(C.names?.[it.by === 'her' ? 'her' : 'me'])
    const parts = []
    if (who) parts.push(`${t(GT.from)} ${who}`)
    const d = A.fmtDate(it.at)
    if (d) parts.push(d)
    return parts
  }
  function setAspect (it) {
    if (!it.tile) return
    const w = it.w || 4, h = it.h || 5
    it.tile.style.setProperty('--ar', `${w} / ${h}`)
    it.tile.style.setProperty('--rv', `${((42.5 * w) / h).toFixed(2)}%`)
  }
  function mkTile (it) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'tile'
    const ph = document.createElement('div'); ph.className = 'ph'
    const soft = new Image(); soft.className = 'soft'; soft.alt = ''
    const sharp = new Image(); sharp.className = 'sharp'; sharp.alt = altOf(it)
    if (it.ph) soft.src = it.ph
    else soft.hidden = true
    if (it.focal) soft.style.objectPosition = sharp.style.objectPosition = `${it.focal[0] * 100}% ${it.focal[1] * 100}%`
    const haze = document.createElement('i'); haze.className = 'haze'
    ph.append(soft, sharp)
    b.append(ph, haze)
    b.setAttribute('aria-label', altOf(it))
    b.addEventListener('click', () => openLB(items.indexOf(it)))
    b.__it = it
    it.tile = b
    setAspect(it)
    return b
  }

  // ---------- tiles develop as they decrypt: the ones in view first, six at a time ----------
  // (on a slow phone link a small thumbnail is mostly round-trip wait, so more of them in flight shows more sooner)
  const waiting = []
  let active = 0
  const enqueue = (...its) => { waiting.unshift(...its); pump() } // the latest to come into view goes first
  function pump () {
    while (active < 6 && waiting.length) {
      active++
      loadTile(waiting.shift()).catch(() => {}).finally(() => { active--; pump() })
    }
  }
  async function thumbURL (blob, maxW) {
    let src, url
    try { src = await createImageBitmap(blob) } catch { url = URL.createObjectURL(blob); src = new Image(); src.src = url; await src.decode() }
    const w = src.width, h = src.height, s = Math.min(1, maxW / w)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s))
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height)
    src.close?.()
    if (url) URL.revokeObjectURL(url)
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86))
    c.width = c.height = 0
    return out ? URL.createObjectURL(out) : null
  }
  async function loadTile (it) {
    if (!it.tile?.isConnected) return
    it.thumb ||= it.kind === 'story' ? (await A.thumb(it.id)).url : await upThumb(it)
    const img = it.tile.querySelector('.sharp'), ph = it.tile.querySelector('.ph'), haze = it.tile.querySelector('.haze')
    img.src = it.thumb
    try { await img.decode() } catch {}
    img.style.opacity = 1
    if (A.reduce()) { img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); haze.style.opacity = 0; return }
    img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 750, easing: EASE })
    ph.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 1000, easing: EASE })
    haze.animate([{ opacity: 0.7 }, { opacity: 0 }], { duration: 750, easing: EASE, fill: 'forwards' })
  }
  // upload file: [u32 head length][head JSON][image]
  function unpack (it, bytes) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)))
    Object.assign(it, { caption: head.caption || '', by: head.by === 'me' ? 'me' : 'her', at: head.at, w: head.w, h: head.h })
    setAspect(it)
    const s = it.tile?.querySelector('.sharp')
    if (s) { s.alt = altOf(it); it.tile.setAttribute('aria-label', altOf(it)) }
    return new Blob([bytes.subarray(4 + n)], { type: /^image\/(jpeg|png|webp)$/.test(head.type) ? head.type : 'image/jpeg' }) // never a type a browser would run
  }
  async function upBlob (it) {
    return (it.blob ||= unpack(it, await sealed(it.name)))
  }
  // each upload has a small copy in t/ (same name); one without it is shrunk here from the full photo
  async function upThumb (it) {
    const p = soon.get(it.name) || sealed('t/' + it.name)
    soon.delete(it.name)
    try { return URL.createObjectURL(unpack(it, await p)) } catch (e) {
      if (e.message === 'paused') throw e
      return thumbURL(await upBlob(it), 620)
    }
  }
  function observe (it) {
    if (!io) {
      io = new IntersectionObserver((es) => {
        const its = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
          .map((e) => { io.unobserve(e.target); return e.target.__it })
        if (its.length) enqueue(...its)
      }, { root: scroller, rootMargin: '500px 0px' })
    }
    io.observe(it.tile)
  }
  function build () {
    built = true
    for (const it of storyItems()) { items.push(it); grid.append(mkTile(it)); observe(it) }
  }
  function firstStoryTile () { return items.find((i) => i.kind === 'story')?.tile || null }
  function addUpload (it, fresh) {
    const ups = items.filter((i) => i.kind === 'up')
    const after = ups.filter((u) => u.name > it.name) // newest first
    const at = after.length ? items.indexOf(after[after.length - 1]) + 1 : 0
    items.splice(at, 0, it)
    const tile = mkTile(it)
    const nextTile = items[at + 1]?.tile || null
    grid.insertBefore(tile, nextTile && nextTile.parentNode === grid ? nextTile : firstStoryTile())
    if (fresh) { tile.classList.add('new'); enqueue(it) } else observe(it)
    renderHead()
  }
  async function sync () {
    if (!gh || paused) return
    let list = early && Date.now() - earlyAt < 30000 ? await early : null
    early = null
    list ??= await listing()
    if (list === 'paused') return pause()
    if (!list) return
    const names = new Set(list.map((f) => f.name))
    for (const it of items.filter((i) => i.kind === 'up' && i.sha && !names.has(i.name))) removeItem(it)
    for (const f of list) {
      const have = items.find((i) => i.name === f.name)
      if (have) { have.sha = f.sha; continue }
      addUpload({ kind: 'up', name: f.name, sha: f.sha, w: 4, h: 5 }, false)
    }
  }
  async function dropThumb (name) { // best effort: a leftover small copy is harmless
    try {
      const r = await fetch(api('t/' + name) + ref(), { headers: H(), cache: 'no-store' })
      if (r.ok) await ghDel('t/' + name, (await r.json()).sha)
    } catch {}
  }
  function removeItem (it) {
    const k = items.indexOf(it)
    if (k < 0) return
    items.splice(k, 1)
    it.tile?.remove()
    shelf.then((c) => { c?.delete(shelved(it.name)); c?.delete(shelved('t/' + it.name)) })
    if (it.thumb) URL.revokeObjectURL(it.thumb)
    if (it.full) URL.revokeObjectURL(it.full)
    renderHead()
  }

  // ---------- header ----------
  function renderHead () {
    $('.gtitle').textContent = t(GT.title)
    $('.gsub').textContent = t(GT.subtitle)
    $('.addt').textContent = t(GT.add)
    off.textContent = t(GT.offline)
    addBtn.hidden = paused
    off.hidden = !paused
    empty.textContent = t(GT.empty)
    empty.hidden = paused || items.some((i) => i.kind === 'up')
  }

  // ---------- lightbox ----------
  function fitLB () {
    const it = items[lbI]
    if (!it) return
    const W = lbStage.clientWidth, Hh = lbStage.clientHeight, ar = (it.w || 4) / (it.h || 5)
    let w = W, h = W / ar
    if (h > Hh) { h = Hh; w = Hh * ar }
    lbPh.style.width = `${Math.floor(w)}px`
    lbPh.style.height = `${Math.floor(h)}px`
  }
  function openLB (i) {
    if (i < 0) return
    lbI = i
    lb.hidden = false
    requestAnimationFrame(() => lb.classList.add('on'))
    renderLB()
    $('#close').focus({ preventScroll: true })
  }
  function closeLB () {
    if (lb.hidden) return
    lbTok++
    lb.classList.remove('on')
    const tile = items[lbI]?.tile
    setTimeout(() => { if (!lb.classList.contains('on')) { lb.hidden = true; lbSharp.removeAttribute('src') } }, 460)
    tile?.focus({ preventScroll: true })
  }
  async function renderLB () {
    const it = items[lbI]
    if (!it) return closeLB()
    const tok = ++lbTok
    fitLB()
    const quick = !!it.thumb // the tile's copy shows at once; the full photo quietly replaces it when it arrives
    lbSoft.hidden = quick || !it.ph
    if (!lbSoft.hidden) lbSoft.src = it.ph
    lbSoft.style.opacity = 1
    cancel(lbSharp); cancel(lbHaze); cancel(lbSoft)
    if (quick) lbSharp.src = it.thumb
    lbSharp.style.opacity = quick ? 1 : 0
    lbHaze.style.opacity = quick ? 0 : it.ph ? 0.35 : 0.9
    lbCap.textContent = capOf(it)
    A.setParts(lbSub, subOf(it))
    lbDel.classList.remove('ask')
    lbDel.hidden = it.kind !== 'up' || paused
    $('.del span').textContent = t(GT.delete)
    $('.lb-confirm').textContent = t(GT.confirmDelete)
    $('.del-yes span').textContent = t(GT.delete)
    $('.del-no span').textContent = t(C.ui.close)
    let url
    try {
      if (it.kind === 'story') url = (await A.photo(it.id)).url
      else url = it.full ||= URL.createObjectURL(await upBlob(it))
    } catch { return }
    if (tok !== lbTok) return
    lbCap.textContent = capOf(it)
    A.setParts(lbSub, subOf(it))
    fitLB()
    lbSharp.alt = altOf(it)
    lbSharp.src = url
    try { await lbSharp.decode() } catch {}
    if (tok !== lbTok) return
    if (!quick) {
      const ms = A.reduce() ? 300 : 1000
      lbSharp.style.opacity = 1
      lbSharp.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: EASE })
      lbHaze.style.opacity = 0
      lbHaze.animate([{ opacity: it.ph ? 0.35 : 0.9 }, { opacity: 0 }], { duration: ms, easing: EASE })
      // the blurred layer never animates (iOS filter bug); it just goes once the sharp one covers it
      setTimeout(() => { if (tok === lbTok) lbSoft.style.opacity = 0 }, ms + 50)
    }
    // keep the neighbours warm
    for (const j of [lbI - 1, lbI + 1]) {
      const n = items[j]
      if (n?.kind === 'story') A.photo(n.id).catch(() => {})
      else if (n) upBlob(n).catch(() => {})
    }
  }
  const cancel = (e) => e.getAnimations().forEach((a) => a.cancel())
  function step (d) {
    if (lb.hidden || !items.length) return
    lbI = (lbI + d + items.length) % items.length
    renderLB()
  }
  $('#close').addEventListener('click', closeLB)
  $('.lb-prev').addEventListener('click', () => step(-1))
  $('.lb-next').addEventListener('click', () => step(1))
  let sw = null
  lb.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) sw = { x: e.clientX, y: e.clientY, id: e.pointerId } })
  lb.addEventListener('pointerup', (e) => {
    if (!sw || e.pointerId !== sw.id) return
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y
    sw = null
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) step((dx < 0) !== (A.getLang() === 'fa') ? 1 : -1)
  })
  lb.addEventListener('pointercancel', () => { sw = null })
  $('.del').addEventListener('click', () => lbDel.classList.add('ask'))
  $('.del-no').addEventListener('click', () => lbDel.classList.remove('ask'))
  $('.del-yes').addEventListener('click', async () => {
    const it = items[lbI]
    if (!it || it.kind !== 'up' || paused) return
    lbDel.classList.remove('ask')
    let r
    try { r = await ghDel(it.name, it.sha) } catch { return }
    if (r.status === 401 || r.status === 403) return pause()
    if (!r.ok && r.status !== 404) return
    removeItem(it)
    dropThumb(it.name)
    if (!items.length) return closeLB()
    lbI = Math.min(lbI, items.length - 1)
    renderLB()
  })
  addEventListener('resize', () => { if (!lb.hidden) fitLB() })

  // ---------- the add sheet ----------
  function renderSheet () {
    $('.pick-t').textContent = picked ? '' : t(GT.add)
    $('.cap-ph').textContent = t(GT.caption) // drawn as text (see .cap in style.css); the field keeps it as its name
    cap.setAttribute('aria-label', t(GT.caption))
    $('.from-l').textContent = t(GT.from)
    $$('.from button').forEach((b) => {
      b.textContent = t(C.names?.[b.dataset.by])
      b.setAttribute('aria-pressed', String(b.dataset.by === by))
    })
    $('span', send).textContent = t(GT.send)
    $('.sheet-x').setAttribute('aria-label', t(C.ui.close))
    $('#close').setAttribute('aria-label', t(C.ui.close))
  }
  function setStatus (msg, busy = false) {
    status.textContent = msg
    status.classList.toggle('busy', busy)
  }
  function openSheet () {
    if (paused) return
    renderSheet()
    back.hidden = false
    sheet.hidden = false
    requestAnimationFrame(() => requestAnimationFrame(() => { back.classList.add('on'); sheet.classList.add('on') }))
    $('.sheet-x').focus({ preventScroll: true })
  }
  // iOS lays its keyboard over the page: lift the sheet so the caption stays in sight while typing
  const vv = window.visualViewport
  let sheetLift = 0
  const liftSheet = () => {
    const on = vv && document.activeElement === cap && !sheet.hidden && innerHeight - vv.height > 120
    // measure against the un-lifted position, or the lift would undo itself on the next resize
    sheetLift = on ? Math.max(0, Math.round(cap.getBoundingClientRect().bottom + sheetLift + 96 - (vv.offsetTop + vv.height))) : 0
    sheet.style.translate = sheetLift ? `0 ${-sheetLift}px` : ''
  }
  vv?.addEventListener('resize', liftSheet)
  cap.addEventListener('focus', () => setTimeout(liftSheet, 60))
  cap.addEventListener('blur', () => setTimeout(liftSheet, 60))
  function closeSheet () {
    sheet.classList.remove('on')
    back.classList.remove('on')
    setTimeout(() => { if (!sheet.classList.contains('on')) { sheet.hidden = true; back.hidden = true } }, 620)
    addBtn.focus({ preventScroll: true })
  }
  function resetSheet () {
    if (picked) URL.revokeObjectURL(picked.url)
    picked = null
    prev.removeAttribute('src')
    cancel(prev); cancel(pHaze); cancel(lift)
    prev.style.opacity = 0; pHaze.style.opacity = 0; lift.style.opacity = 0
    pick.classList.remove('has')
    cap.value = ''
    send.disabled = true
    setStatus('')
    renderSheet()
  }
  async function shrink (f, max = 1600, q = 0.85, byWidth = false) {
    let src, url
    try { src = await createImageBitmap(f, { imageOrientation: 'from-image' }) } catch {
      url = URL.createObjectURL(f)
      src = new Image()
      src.src = url
      await src.decode()
    }
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, s = Math.min(1, max / (byWidth ? w : Math.max(w, h)))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s))
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height) // drawn once, straight to the target size
    src.close?.()
    if (url) URL.revokeObjectURL(url)
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', q))
    const out = { blob, w: c.width, h: c.height }
    c.width = c.height = 0 // iOS canvas memory
    return out
  }
  async function packed (head, blob) { // sealed upload file: [u32 head length][head JSON][image]
    const hb = new TextEncoder().encode(JSON.stringify(head))
    const jb = new Uint8Array(await blob.arrayBuffer())
    const pack = new Uint8Array(4 + hb.length + jb.length)
    new DataView(pack.buffer).setUint32(0, hb.length)
    pack.set(hb, 4)
    pack.set(jb, 4 + hb.length)
    return b64(await seal(A.key, pack))
  }
  file.addEventListener('change', async () => {
    const f = file.files?.[0]
    file.value = ''
    if (!f) return
    setStatus('')
    let p
    try {
      p = await shrink(f)
      p.small = (await shrink(p.blob, 560, 0.8, true)).blob // the gallery tile's copy
    } catch { setStatus(t(GT.error)); return }
    p.url = URL.createObjectURL(p.blob)
    if (picked) URL.revokeObjectURL(picked.url)
    picked = p
    prev.src = p.url
    try { await prev.decode() } catch {}
    pick.classList.add('has')
    $('.pick-t').textContent = ''
    // the preview develops out of white haze
    cancel(prev); cancel(pHaze); cancel(lift)
    lift.style.opacity = 0
    prev.style.opacity = 1
    pHaze.style.opacity = 0
    const ms = A.reduce() ? 300 : 1700
    pHaze.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE })
    prev.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: ms, easing: EASE })
    send.disabled = false
  })
  $$('.from button').forEach((b) => b.addEventListener('click', () => {
    by = b.dataset.by
    A.store.set('lg-by', by)
    renderSheet()
  }))
  send.addEventListener('click', async () => {
    if (!picked || sending || paused) return
    sending = true
    send.disabled = true
    setStatus(t(GT.uploading), true)
    cancel(lift)
    lift.style.opacity = 0.6
    lift.animate([{ opacity: 0 }, { opacity: 0.6 }], { duration: A.reduce() ? 300 : 5000, easing: 'ease-out' }) // the preview slowly brightens
    let ok = false
    try {
      const head = { caption: cap.value.trim(), by, at: new Date().toISOString(), w: picked.w, h: picked.h, type: 'image/jpeg' }
      const hex = [...crypto.getRandomValues(new Uint8Array(2))].map((x) => x.toString(16).padStart(2, '0')).join('')
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${hex}.txt` // never .bin: download managers grab those
      const r = await ghPut(name, await packed(head, picked.blob))
      if (r.status === 401 || r.status === 403) { sending = false; pause(); return }
      if (r.ok) {
        const { blob, small } = picked
        packed(head, small).then((c) => ghPut('t/' + name, c)).catch(() => {}) // the small copy, right behind it
        const j = await r.json().catch(() => ({}))
        ok = true
        setStatus(t(GT.done))
        await sleep(900)
        closeSheet()
        addUpload({ kind: 'up', name, sha: j?.content?.sha, ...head, blob, thumb: URL.createObjectURL(small) }, true)
        setTimeout(resetSheet, 650)
        scroller.scrollTo({ top: 0, behavior: A.reduce() ? 'auto' : 'smooth' })
      }
    } catch {}
    if (!ok) {
      setStatus(t(GT.error))
      cancel(lift)
      lift.style.opacity = 0
      send.disabled = false
    }
    sending = false
  })
  addBtn.addEventListener('click', openSheet)
  back.addEventListener('click', closeSheet)
  $('.sheet-x').addEventListener('click', closeSheet)

  return {
    enter () {
      if (!built) build()
      A.orsi('faint')
      A.washDim(0.55)
      const sc = C.scenes[C.scenes.length - 1]
      A.wash(C.photos[sc?.photos[0]]?.ph)
      renderHead()
      renderSheet()
      scroller.scrollTop = 0
      sync()
    },
    leave () { closeLB(); if (!sheet.hidden) closeSheet() },
    relang () {
      renderHead()
      renderSheet()
      for (const it of items) {
        const s = it.tile?.querySelector('.sharp')
        if (s) s.alt = altOf(it)
        it.tile?.setAttribute('aria-label', altOf(it))
      }
      if (!lb.hidden) { lbCap.textContent = capOf(items[lbI]); A.setParts(lbSub, subOf(items[lbI])) }
    },
    key (e) {
      if (e.key === 'Escape') { if (!lb.hidden) closeLB(); else if (!sheet.hidden) closeSheet(); return }
      if (lb.hidden) return
      const rtl = A.getLang() === 'fa'
      if (e.key === 'ArrowRight') { e.preventDefault(); step(rtl ? -1 : 1) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(rtl ? 1 : -1) }
    },
  }
}
