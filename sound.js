// Sound: Clair de lune through a GainNode (iOS ignores audio.volume) plus small synthesized
// sounds tuned to D-flat major pentatonic, all sent through one generated reverb.
const music = document.getElementById('music')
const PENT = [554.37, 622.25, 698.46, 830.61, 932.33] // Db5 Eb5 F5 Ab5 Bb5
let ctx, master, sfx, verb, mGain, nbuf
let muted = false
let musicOn = false   // the story has started the music (after unlock)
let level = 0         // current music target level
let wipe = null
let musicReady = false // the real track's blob is on the element (it can land seconds after the gesture)
let started = false    // start() ran inside the unlock gesture

export const isMuted = () => muted
export function setInitialMute (m) { muted = !!m }

// Half a second of 8-bit silence. Playing it inside the unlock gesture "activates" the element, so WebKit
// (iOS Safari, Telegram iOS) lets us play() the real track later, when its download finishes.
function silence () {
  const n = 4000, v = new DataView(new ArrayBuffer(44 + n))
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true)
  w(36, 'data'); v.setUint32(40, n, true)
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128)
  return URL.createObjectURL(new Blob([v], { type: 'audio/wav' }))
}

// The track ships as plain bytes named .m4a.txt (download managers grab .m4a URLs), so it is fetched
// and handed to the element as a blob. It may land after the unlock gesture: the element was already
// played inside that gesture (WebKit then allows later play() calls), so it starts and fades in here.
export function loadMusic (url, tries = 3) {
  fetch(url).then((r) => { if (!r.ok) throw new Error('music ' + r.status); return r.arrayBuffer() }).then((buf) => {
    const old = music.src
    music.src = URL.createObjectURL(new Blob([buf], { type: 'audio/mp4' }))
    musicReady = true
    if (old.startsWith('blob:')) URL.revokeObjectURL(old) // the silent placeholder
    if (!started || muted) return
    if (ctx && musicOn) { const g = mGain.gain, t = ctx.currentTime; g.cancelScheduledValues(t); g.setValueAtTime(0, t); g.linearRampToValueAtTime(level, t + 3) }
    if (!document.hidden) music.play().catch(() => {})
  }).catch(() => { if (tries > 1) setTimeout(() => loadMusic(url, tries - 1), 4000) })
}

// MUST run synchronously inside a click / keydown / pointerup handler (iOS user gesture).
export function start () {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch {}
  started = true
  const AC = window.AudioContext || window.webkitAudioContext
  if (!ctx && !AC) { // no Web Audio (rare webviews): the element still plays, just without fades
    if (!musicReady && !music.src) music.src = silence()
    if (!musicOn) music.volume = 0
    if (!muted && music.paused) music.play().catch(() => {})
    return
  }
  if (!ctx) {
    ctx = new AC({ latencyHint: 'interactive' })
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 1
    master.connect(ctx.destination)
    sfx = ctx.createGain()
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 3
    comp.attack.value = 0.004; comp.release.value = 0.25
    sfx.connect(comp).connect(master)
    verb = ctx.createConvolver()
    verb.buffer = impulse(2.2)
    const wet = ctx.createGain(); wet.gain.value = 0.6
    verb.connect(wet).connect(master)
    mGain = ctx.createGain(); mGain.gain.value = 0
    try { ctx.createMediaElementSource(music).connect(mGain).connect(master) } catch {}
    // a one-sample buffer unlocks output on older WebKit
    const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start()
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {})
  // On a slow connection the track is still downloading: play silence now so the element is gesture-activated.
  if (!musicReady && !music.src) music.src = silence()
  if (!muted && music.paused) music.play().catch(() => {})
}

// Any later tap: if iOS left the context suspended/interrupted, bring it back (pointerup is a gesture).
export function wake () {
  if (!started) return
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {})
  if (musicOn && !muted && music.paused) music.play().catch(() => {})
}

export function musicTo (v, sec = 2) {
  level = v
  // it has been playing silently since the first try at the gate: the story starts from the first bar
  if (v > 0 && !musicOn) { try { music.currentTime = 0 } catch {} }
  if (v > 0) musicOn = true
  if (!ctx) { // no Web Audio: plain element volume (iOS always has Web Audio, so this path never meets its volume quirk)
    music.volume = Math.min(1, v * 1.4)
    if (v > 0 && started && !muted && music.paused && !document.hidden) music.play().catch(() => {})
    return
  }
  ramp(mGain.gain, v, sec)
  // the element was first played inside a gesture, so WebKit lets it resume here (e.g. after the tab was hidden)
  if (v > 0 && !muted && music.paused && !document.hidden) music.play().catch(() => {})
}
export const musicLevel = () => level

export function setMuted (m) {
  muted = !!m
  document.body.classList.toggle('muted', muted)
  if (!started) return
  if (ctx) ramp(master.gain, muted ? 0 : 1, 0.2)
  if (muted) setTimeout(() => { if (muted) music.pause() }, ctx ? 260 : 0)
  else { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); if (musicOn) music.play().catch(() => {}) }
}

document.addEventListener('visibilitychange', () => {
  if (!started) return
  if (document.hidden) { music.pause(); ctx?.suspend().catch(() => {}) }
  else if (!muted) { ctx?.resume().catch(() => {}); if (musicOn || level > 0) music.play().catch(() => {}) }
})

// ---------- helpers ----------
function ramp (p, to, sec) {
  const t = ctx.currentTime
  p.cancelScheduledValues(t)
  p.setValueAtTime(p.value, t)
  p.linearRampToValueAtTime(to, t + Math.max(0.01, sec))
}
function impulse (sec) {
  const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-5.2 * i / n)
  }
  return b
}
function noise () {
  if (!nbuf) {
    nbuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = nbuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  const s = ctx.createBufferSource(); s.buffer = nbuf; s.loop = true
  return s
}
const live = () => ctx && !muted && ctx.state === 'running'
function out (node, send = 0.4) {
  node.connect(sfx)
  if (send > 0) { const g = ctx.createGain(); g.gain.value = send; node.connect(g).connect(verb) }
}
function env (g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + a)
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d)
}
function tone (type, f, t, a, peak, d, send) {
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.type = type; o.frequency.value = f
  env(g, t, a, peak, d)
  o.connect(g); out(g, send)
  o.start(t); o.stop(t + a + d + 0.05)
  return o
}

// ---------- the sounds ----------
// Glass chime: sine + triangle pair, 5 ms attack, 1.6 s decay. i picks a pentatonic step (5+ = octave up).
export function chime (i = 0, gain = 0.045, delay = 0) {
  if (!live()) return
  const t = ctx.currentTime + 0.005 + delay
  const k = ((i % 10) + 10) % 10
  const f = PENT[k % 5] * (k >= 5 ? 2 : 1)
  tone('sine', f, t, 0.005, gain, 1.6, 0.55)
  tone('triangle', f * 2, t, 0.005, gain * 0.16, 0.9, 0.5)
  tone('sine', f * 2.756, t, 0.003, gain * 0.07, 0.35, 0.4) // the glassy partial
}

// Bandpassed noise swelling over 400 ms.
export function whoosh (gain = 0.05) {
  if (!live()) return
  const t = ctx.currentTime + 0.01, s = noise(), bp = ctx.createBiquadFilter(), g = ctx.createGain()
  bp.type = 'bandpass'; bp.Q.value = 0.8
  bp.frequency.setValueAtTime(380, t)
  bp.frequency.exponentialRampToValueAtTime(1500, t + 0.3)
  bp.frequency.exponentialRampToValueAtTime(650, t + 0.48)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.28)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
  s.connect(bp).connect(g); out(g, 0.45)
  s.start(t); s.stop(t + 0.55)
}

// Sine with a quick 120 ms pitch drop; the base climbs the pentatonic with every No attempt.
const BLOOP = [277.18, 311.13, 349.23, 415.30, 466.16, 554.37, 622.25, 698.46, 830.61, 932.33, 1108.73, 1244.51, 1396.91]
export function bloop (n = 0) {
  if (!live()) return
  const t = ctx.currentTime + 0.005, f = BLOOP[Math.min(n, BLOOP.length - 1)]
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(f * 1.55, t)
  o.frequency.exponentialRampToValueAtTime(f, t + 0.12)
  env(g, t, 0.006, 0.06, 0.2)
  o.connect(g); out(g, 0.3)
  o.start(t); o.stop(t + 0.3)
}

// Dbmaj9 pad: detuned saws into a 1.2 kHz lowpass, 800 ms attack, 2.5 s release.
export function swell () {
  if (!live()) return
  const t = ctx.currentTime + 0.01, lp = ctx.createBiquadFilter(), g = ctx.createGain()
  lp.type = 'lowpass'; lp.frequency.value = 1200; lp.Q.value = 0.4
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.055, t + 0.8)
  g.gain.setValueAtTime(0.055, t + 1.5)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 4)
  for (const f of [138.59, 207.65, 261.63, 311.13, 349.23]) {
    for (const d of [-7, 6]) {
      const o = ctx.createOscillator(), og = ctx.createGain()
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d; og.gain.value = 0.11
      o.connect(og).connect(lp); o.start(t); o.stop(t + 4.1)
    }
  }
  lp.connect(g); out(g, 0.65)
}

// Soft low tick for a wrong answer.
export function tick () {
  if (!live()) return
  const t = ctx.currentTime + 0.005, s = noise(), bp = ctx.createBiquadFilter(), g = ctx.createGain()
  bp.type = 'bandpass'; bp.frequency.value = 820; bp.Q.value = 2.2
  env(g, t, 0.002, 0.07, 0.07)
  s.connect(bp).connect(g); out(g, 0.2)
  s.start(t); s.stop(t + 0.12)
  tone('sine', 196, t, 0.003, 0.03, 0.09, 0.1)
}

// Heartbeat: 60 Hz sine thump (with a soft 2nd harmonic so phone speakers carry it), lub then dub.
export function heartbeat () {
  if (!live()) return
  const t = ctx.currentTime + 0.005
  thump(t, 1); thump(t + 0.2, 0.62)
}
function thump (t, v) {
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), g2 = ctx.createGain()
  o.type = o2.type = 'sine'
  o.frequency.setValueAtTime(72, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.09)
  o2.frequency.setValueAtTime(130, t); o2.frequency.exponentialRampToValueAtTime(110, t + 0.09)
  env(g, t, 0.008, 0.13 * v, 0.09)
  env(g2, t, 0.008, 0.035 * v, 0.07)
  o.connect(g); o2.connect(g2); out(g, 0); out(g2, 0.05)
  o.start(t); o2.start(t); o.stop(t + 0.2); o2.stop(t + 0.2)
}

// Paper: a 300 ms highpassed noise burst with a little crackle, for the letter.
export function paper () {
  if (!live()) return
  const t = ctx.currentTime + 0.01
  for (const [dt, peak, len] of [[0, 0.03, 0.3], [0.11, 0.018, 0.22]]) {
    const s = noise(), hp = ctx.createBiquadFilter(), g = ctx.createGain()
    hp.type = 'highpass'; hp.frequency.value = 2300
    const t0 = t + dt
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.03)
    for (let k = 1; k < 7; k++) g.gain.setValueAtTime(peak * (0.35 + Math.random() * 0.65), t0 + 0.03 + k * len / 9)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len)
    s.connect(hp).connect(g); out(g, 0.25)
    s.start(t0); s.stop(t0 + len + 0.05)
  }
}

// Finger on fogged glass: a soft hiss that follows the speed of the finger.
export function wipeStart () {
  if (!live() || wipe) return
  const s = noise(), bp = ctx.createBiquadFilter(), g = ctx.createGain()
  bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.7
  g.gain.value = 0
  s.connect(bp).connect(g); out(g, 0.15)
  s.start()
  wipe = { s, g, bp }
}
export function wipeSpeed (v) { // v in css px per ms
  if (!wipe) return
  const t = ctx.currentTime
  wipe.g.gain.setTargetAtTime(Math.min(0.022, v * 0.012), t, 0.05)
  wipe.bp.frequency.setTargetAtTime(2000 + Math.min(1800, v * 900), t, 0.08)
}
export function wipeEnd () {
  if (!wipe) return
  const { s, g } = wipe, t = ctx.currentTime
  g.gain.setTargetAtTime(0, t, 0.05)
  s.stop(t + 0.4)
  wipe = null
}
