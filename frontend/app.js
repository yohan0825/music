// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const PPS = 80; // pixels per second

const COLORS = [
  '#7c6af7','#e05b4a','#4ecca3','#f0a500','#42a5f5',
  '#ab47bc','#26a69a','#ec407a','#66bb6a','#ff7043',
];
let colorIdx = 0;

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const tracks = [];       // { id, title, duration, stream_url, download_url }
const mixerTracks = [];  // mixer track objects
const pads = Array(9).fill(null); // { id, title, duration, buffer } | null
const padSources = Array(9).fill(null);

let audioCtx = null;
let mixerPlaying = false;
let startCtxTime = 0;
let startPlayhead = 0;
let currentPlayhead = 0;
let animFrame = null;
let mixerSources = [];

// ─────────────────────────────────────────────
// Audio helpers
// ─────────────────────────────────────────────
function getCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

let masterGain = null;
let masterVolNode = null;
let masterAnalyser = null;
let impulseBuffer = null;

function getImpulseResponse(ctx) {
  if (!impulseBuffer) {
    const dur = 2.5, sr = ctx.sampleRate;
    impulseBuffer = ctx.createBuffer(2, sr * dur, sr);
    for (let c = 0; c < 2; c++) {
      const d = impulseBuffer.getChannelData(c);
      for (let i = 0; i < d.length; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.8);
    }
  }
  return impulseBuffer;
}

function getMaster() {
  if (!masterGain) {
    const ctx = getCtx();
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;

    masterVolNode = ctx.createGain();
    masterVolNode.gain.value = 0.9;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 512;
    masterAnalyser.smoothingTimeConstant = 0.8;

    masterGain.connect(masterVolNode);
    masterVolNode.connect(limiter);
    limiter.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);
  }
  return masterGain;
}

async function loadBuffer(trackId) {
  const ctx = getCtx();
  const resp = await fetch(`/api/audio/${trackId}`);
  const arr = await resp.arrayBuffer();
  return ctx.decodeAudioData(arr);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// 포인터 드래그 추적: pointerdown 이후 같은 포인터(손가락/마우스)의 move를 따라가고
// up/cancel에서 정리한다. pointerId 필터라 멀티터치(양쪽 덱 동시 스크래치)도 안전.
function trackPointer(e, onMove, onUp) {
  const move = ev => { if (ev.pointerId === e.pointerId) onMove(ev); };
  const finish = ev => {
    if (ev.pointerId !== e.pointerId) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    onUp(ev);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

// ─────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─────────────────────────────────────────────
// Extract tab
// ─────────────────────────────────────────────
const extractForm   = document.getElementById('extract-form');
const urlInput      = document.getElementById('url-input');
const extractBtn    = document.getElementById('extract-btn');
const statusEl      = document.getElementById('status');
const trackListEl   = document.getElementById('track-list');

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ` ${type}` : '');
}

const trackEmptyState = document.getElementById('track-empty-state');

function addTrackToList(track) {
  tracks.push(track);
  knownTrackIds.add(track.id);
  trackEmptyState.style.display = 'none';

  const li = document.createElement('li');
  li.className = 'track-item';
  li.dataset.id = track.id;
  li.innerHTML = `
    <div class="track-header">
      <span class="track-title">${escHtml(track.title)}</span>
      <span class="track-dur">${fmtTime(track.duration)}</span>
    </div>
    <div class="track-actions">
      <audio controls src="${track.stream_url}" preload="none" aria-label="${escHtml(track.title)} 미리듣기"></audio>
      <a class="btn-ghost" href="${track.download_url}" download aria-label="${escHtml(track.title)} 다운로드">⬇ 다운</a>
      <button class="btn-primary" data-action="mixer" aria-label="믹서에 추가">+믹서</button>
      <button class="btn-outline" data-action="pad" aria-label="샘플러 패드에 추가">+패드</button>
      <button class="btn-ghost"  data-action="playlist" aria-label="플레이리스트에 추가">+목록</button>
      <button class="btn-danger" data-action="delete" aria-label="${escHtml(track.title)} 삭제">🗑</button>
    </div>
  `;
  li.addEventListener('click', e => {
    const action = e.target.dataset.action;
    if (action === 'mixer')    addToMixer(track);
    if (action === 'pad')      addToPad(track);
    if (action === 'playlist') addToPlaylist(track);
    if (action === 'delete')   removeTrack(track.id, li);
  });
  trackListEl.prepend(li);
}

async function removeTrack(id, li) {
  if (!id.startsWith('rec_')) {
    const res = await fetch(`/api/tracks/${id}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) setStatus('파일 삭제 실패 (이미 없거나 권한 오류)', 'error');
  }
  const idx = tracks.findIndex(t => t.id === id);
  if (idx >= 0) tracks.splice(idx, 1);
  li.remove();
  if (tracks.length === 0) trackEmptyState.style.display = '';
}

extractForm.addEventListener('submit', async e => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  extractBtn.disabled = true;
  setStatus('대기열에 추가하는 중... ⏳');
  try {
    const res  = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '추가 실패');
    setStatus(data.message || '대기열에 추가됐어요. 집 PC가 처리하면 아래에 나타나요 ⏳', 'success');
    urlInput.value = '';
    startQueuePolling();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    extractBtn.disabled = false;
  }
});

// ── 추출 큐 폴링: 워커가 처리하면 라이브러리에 자동 등장 ──
const knownTrackIds = new Set();
let queuePollTimer = null;

async function refreshTracks() {
  try {
    const list = await (await fetch('/api/tracks')).json();
    for (const t of list) {
      if (knownTrackIds.has(t.id)) continue;
      knownTrackIds.add(t.id);
      addTrackToList({
        ...t,
        stream_url: `/api/audio/${t.id}`,
        download_url: `/api/audio/${t.id}?download=1`,
      });
    }
  } catch {}
}

const queueSection = document.getElementById('queue-section');
const queueListEl  = document.getElementById('queue-list');
const QUEUE_STATUS_LABEL = { pending: '대기', processing: '처리 중', error: '실패' };

function renderQueue(queue) {
  queueSection.style.display = queue.length ? '' : 'none';
  queueListEl.innerHTML = '';
  queue.forEach(q => {
    const li = document.createElement('li');
    li.className = `queue-item q-${q.status}`;
    const name = q.title || q.url;
    const errTip = q.error ? ` title="${escHtml(q.error)}"` : '';
    const btns = [];
    if (q.status === 'pending') {
      btns.push('<button class="btn-ghost" data-act="up" aria-label="위로">▲</button>');
      btns.push('<button class="btn-ghost" data-act="down" aria-label="아래로">▼</button>');
    }
    if (q.status === 'error') {
      btns.push('<button class="btn-ghost" data-act="retry" aria-label="재시도">↻</button>');
    }
    btns.push('<button class="btn-danger" data-act="del" aria-label="취소">✕</button>');
    li.innerHTML = `
      <span class="queue-status"${errTip}>${QUEUE_STATUS_LABEL[q.status] || q.status}</span>
      <span class="queue-title" title="${escHtml(q.url)}">${escHtml(name)}</span>
      <span class="queue-actions">${btns.join('')}</span>`;
    li.addEventListener('click', async e => {
      const act = e.target.dataset.act;
      if (!act) return;
      try {
        if (act === 'up' || act === 'down') await fetch(`/api/queue/${q.id}/move?dir=${act}`, { method: 'POST' });
        else if (act === 'retry') await fetch(`/api/queue/${q.id}/retry`, { method: 'POST' });
        else if (act === 'del') await fetch(`/api/queue/${q.id}`, { method: 'DELETE' });
      } catch {}
      startQueuePolling();
      pollQueueTick();
    });
    queueListEl.appendChild(li);
  });
}

async function pollQueueTick() {
  await refreshTracks();
  let queue = [];
  try { queue = await (await fetch('/api/queue')).json(); } catch {}
  renderQueue(queue);
  const active = queue.filter(q => q.status === 'pending' || q.status === 'processing');
  if (active.length) {
    setStatus(`대기 중 ${active.length}곡 — 집 PC가 처리 중이에요 ⏳`);
  } else {
    setStatus('');
    stopQueuePolling();
  }
}

function startQueuePolling() {
  if (queuePollTimer) return;
  pollQueueTick();
  queuePollTimer = setInterval(pollQueueTick, 4000);
}

function stopQueuePolling() {
  clearInterval(queuePollTimer);
  queuePollTimer = null;
}

// Upload
const uploadDrop   = document.getElementById('upload-drop');
const uploadInput  = document.getElementById('upload-input');
const uploadStatus = document.getElementById('upload-status');

function setUploadStatus(msg, type = '') {
  uploadStatus.textContent = msg;
  uploadStatus.className = 'status' + (type ? ` ${type}` : '');
}

async function uploadFiles(files) {
  for (const file of files) {
    setUploadStatus(`업로드 중: ${file.name} ⏳`);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '업로드 실패');
      addTrackToList({
        ...data,
        stream_url: `/api/audio/${data.id}`,
        download_url: `/api/audio/${data.id}?download=1`,
      });
      setUploadStatus(`"${data.title}" 업로드 완료!`, 'success');
    } catch (err) {
      setUploadStatus(err.message, 'error');
    }
  }
}

uploadDrop.addEventListener('click', () => uploadInput.click());
uploadDrop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') uploadInput.click(); });
uploadInput.addEventListener('change', () => uploadFiles(Array.from(uploadInput.files)));
uploadDrop.addEventListener('dragover', e => { e.preventDefault(); uploadDrop.classList.add('drag-over'); });
uploadDrop.addEventListener('dragleave', () => uploadDrop.classList.remove('drag-over'));
uploadDrop.addEventListener('drop', e => {
  e.preventDefault();
  uploadDrop.classList.remove('drag-over');
  uploadFiles(Array.from(e.dataTransfer.files));
});

// Load tracks from previous session, then restore project
(async () => {
  await refreshTracks();
  restoreProject();
  // 대기열 렌더 + 남은 작업 있으면 폴링 재개 (없으면 한 번 그리고 알아서 멈춤)
  startQueuePolling();
})();

// ─────────────────────────────────────────────
// Mixer – DOM refs
// ─────────────────────────────────────────────
const mixerPlayBtn   = document.getElementById('mixer-play');
const mixerStopBtn   = document.getElementById('mixer-stop');
const mixerTimeEl    = document.getElementById('mixer-time');
const mixerExportBtn = document.getElementById('mixer-export');
const mixerEmptyEl   = document.getElementById('mixer-empty');
const tlContainer    = document.getElementById('timeline-container');
const tlLabels       = document.getElementById('timeline-labels');
const tlRuler        = document.getElementById('timeline-ruler');
const tlTracks       = document.getElementById('timeline-tracks');
const tlScroll       = document.getElementById('timeline-scroll');
const playheadEl     = document.getElementById('playhead');
const labelCol       = document.getElementById('label-col');

// ─────────────────────────────────────────────
// Mixer – helpers
// ─────────────────────────────────────────────
function getMixerDuration() {
  if (!mixerTracks.length) return 0;
  return Math.max(...mixerTracks.map(mt => mt.startOffset + (mt.trimEnd - mt.trimStart)));
}

function refreshMixerVisibility() {
  const empty = mixerTracks.length === 0;
  mixerEmptyEl.style.display = empty ? '' : 'none';
  tlContainer.style.display  = empty ? 'none' : 'flex';
}

function buildRuler() {
  const w = Math.max(getMixerDuration() * PPS + 300, tlScroll.clientWidth || 900);
  tlRuler.style.width  = w + 'px';
  tlTracks.style.width = w + 'px';
  tlRuler.innerHTML = '';
  const totalSec = w / PPS;
  const step = totalSec > 120 ? 15 : totalSec > 60 ? 10 : 5;
  for (let s = 0; s <= totalSec; s += step) {
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    tick.style.left = s * PPS + 'px';
    tick.textContent = fmtTime(s);
    tlRuler.appendChild(tick);
  }
}

function updatePlayheadEl(pos) {
  playheadEl.style.left = pos * PPS + 'px';
}

function updateMixerTimeDisplay() {
  const pos = mixerPlaying
    ? startPlayhead + (audioCtx.currentTime - startCtxTime)
    : currentPlayhead;
  mixerTimeEl.textContent = `${fmtTime(pos)} / ${fmtTime(getMixerDuration())}`;
}

// Sync label column vertical scroll with timeline scroll area
tlScroll.addEventListener('scroll', () => { labelCol.scrollTop = tlScroll.scrollTop; });

// ─────────────────────────────────────────────
// Add track to mixer
// ─────────────────────────────────────────────
function addToMixer(track) {
  if (mixerTracks.find(mt => mt.id === track.id)) {
    setStatus(`"${track.title}" 이미 믹서에 있어요`, 'error');
    return;
  }
  const mt = {
    id: track.id,
    title: track.title,
    duration: track.duration || 180,
    buffer: null,
    startOffset: getMixerDuration(),
    trimStart: 0,
    trimEnd: track.duration || 180,
    volume: 1,
    muted: false,
    pan: 0,
    automation: [],
    color: COLORS[colorIdx++ % COLORS.length],
    blockEl: null,
    laneEl: null,
  };
  mixerTracks.push(mt);

  if (track._buffer) {
    mt.buffer = track._buffer;
  } else {
    loadBuffer(track.id).then(buf => {
      mt.buffer = buf;
      if (Math.abs(buf.duration - mt.trimEnd) > 0.5) {
        mt.duration = buf.duration;
        mt.trimEnd  = buf.duration;
        updateBlockGeometry(mt);
        buildRuler();
      }
    });
  }

  renderMixerTrack(mt);
  buildRuler();
  refreshMixerVisibility();
  scheduleSave();
  document.querySelector('[data-tab="mixer"]').click();
}

// ─────────────────────────────────────────────
// Render mixer track row (label + lane)
// ─────────────────────────────────────────────
function renderMixerTrack(mt) {
  // Label column entry
  const label = document.createElement('div');
  label.className = 'tl-label';
  label.dataset.id = mt.id;
  label.innerHTML = `
    <div class="tl-label-name" title="${escHtml(mt.title)}">${escHtml(mt.title)}</div>
    <div class="tl-label-controls">
      <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="${mt.volume ?? 1}">
      <input type="range" class="pan-slider" min="-1" max="1" step="0.01" value="${mt.pan ?? 0}" title="Pan L ↔ R">
      <button class="mute-btn ${mt.muted ? 'muted' : ''}">M</button>
      <button class="tl-rm">✕</button>
    </div>
  `;
  label.querySelector('.vol-slider').addEventListener('input', e => { pushUndo(); mt.volume = +e.target.value; scheduleSave(); });
  label.querySelector('.pan-slider').addEventListener('input', e => { pushUndo(); mt.pan = +e.target.value; scheduleSave(); });
  label.querySelector('.mute-btn').addEventListener('click', e => {
    pushUndo();
    mt.muted = !mt.muted;
    e.currentTarget.classList.toggle('muted', mt.muted);
    scheduleSave();
  });
  label.querySelector('.tl-rm').addEventListener('click', () => removeMixerTrack(mt));
  tlLabels.appendChild(label);

  // Timeline lane
  const lane = document.createElement('div');
  lane.className = 'tl-lane';
  lane.dataset.id = mt.id;

  const block = document.createElement('div');
  block.className = 'track-block';
  block.style.background = mt.color;
  block.innerHTML = `
    <div class="trim-handle left"></div>
    <div class="block-label">${escHtml(mt.title)}</div>
    <div class="trim-handle right"></div>
  `;
  updateBlockGeometry(mt, block);
  setupBlockDrag(block, mt);
  setupTrimHandle(block.querySelector('.trim-handle.left'), mt, 'left', block);
  setupTrimHandle(block.querySelector('.trim-handle.right'), mt, 'right', block);

  lane.appendChild(block);
  tlTracks.appendChild(lane);

  mt.blockEl = block;
  mt.laneEl  = lane;
}

function updateBlockGeometry(mt, block) {
  const el = block || mt.blockEl;
  if (!el) return;
  el.style.left  = mt.startOffset * PPS + 'px';
  el.style.width = Math.max((mt.trimEnd - mt.trimStart) * PPS, 16) + 'px';
}

function removeMixerTrack(mt) {
  const idx = mixerTracks.indexOf(mt);
  if (idx >= 0) mixerTracks.splice(idx, 1);
  mt.laneEl?.remove();
  tlLabels.querySelector(`[data-id="${mt.id}"]`)?.remove();
  buildRuler();
  refreshMixerVisibility();
  updateMixerTimeDisplay();
  scheduleSave();
}

// ─────────────────────────────────────────────
// Block drag to reposition
// ─────────────────────────────────────────────
function setupBlockDrag(block, mt) {
  block.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('trim-handle')) return;
    if (e.button === 2) return;
    e.preventDefault();
    pushUndo();
    const startX = e.clientX;
    const origOffset = mt.startOffset;
    trackPointer(e, ev => {
      let t = Math.max(0, origOffset + (ev.clientX - startX) / PPS);
      if (snapEnabled) {
        const bpm = parseFloat(document.getElementById('mixer-bpm')?.value) || 120;
        const beat = 60 / bpm;
        t = Math.round(t / beat) * beat;
      }
      mt.startOffset = t;
      updateBlockGeometry(mt);
    }, () => {
      buildRuler();
      updateMixerTimeDisplay();
      scheduleSave();
    });
  });
}

// ─────────────────────────────────────────────
// Trim handles
// ─────────────────────────────────────────────
function setupTrimHandle(handle, mt, side, block) {
  handle.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    const startX  = e.clientX;
    const origVal = side === 'left' ? mt.trimStart : mt.trimEnd;
    trackPointer(e, ev => {
      const delta = (ev.clientX - startX) / PPS;
      if (side === 'left') {
        mt.trimStart = Math.max(0, Math.min(origVal + delta, mt.trimEnd - 0.5));
      } else {
        mt.trimEnd = Math.max(mt.trimStart + 0.5, Math.min(origVal + delta, mt.duration));
      }
      updateBlockGeometry(mt, block);
      // 눈금 재계산은 드래그 끝에서만
    }, () => {
      buildRuler();
      updateMixerTimeDisplay();
    });
  });
}

// ─────────────────────────────────────────────
// Seek by clicking ruler or empty track area
// ─────────────────────────────────────────────
function seekTo(pos) {
  const was = mixerPlaying;
  if (was) stopMixer(false);
  currentPlayhead = Math.max(0, pos);
  updatePlayheadEl(currentPlayhead);
  updateMixerTimeDisplay();
  if (was) startMixer();
}

tlRuler.addEventListener('click', e => {
  const rect = tlRuler.getBoundingClientRect();
  seekTo((e.clientX - rect.left + tlScroll.scrollLeft) / PPS);
});
tlTracks.addEventListener('click', e => {
  if (e.target.closest('.track-block')) return;
  const rect = tlTracks.getBoundingClientRect();
  seekTo((e.clientX - rect.left + tlScroll.scrollLeft) / PPS);
});

// ─────────────────────────────────────────────
// Mixer playback engine
// ─────────────────────────────────────────────
function startMixer() {
  const ctx = getCtx();
  startCtxTime  = ctx.currentTime;
  startPlayhead = currentPlayhead;
  mixerSources  = [];

  for (const mt of mixerTracks) {
    if (!mt.buffer || mt.muted) continue;
    const trackEnd = mt.startOffset + (mt.trimEnd - mt.trimStart);
    if (currentPlayhead >= trackEnd) continue;

    const delay       = Math.max(0, mt.startOffset - currentPlayhead);
    const audioOffset = mt.trimStart + Math.max(0, currentPlayhead - mt.startOffset);
    const duration    = mt.trimEnd - audioOffset;
    if (duration <= 0) continue;

    const src  = ctx.createBufferSource();
    src.buffer = mt.buffer;
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = mt.pan ?? 0;
    const fade = 0.04;
    const t0 = ctx.currentTime + delay;
    if (mt.automation?.length > 1) {
      const sorted = [...mt.automation].sort((a, b) => a.t - b.t);
      gain.gain.setValueAtTime(sorted[0].v * mt.volume, t0);
      for (const pt of sorted) gain.gain.linearRampToValueAtTime(pt.v * mt.volume, t0 + pt.t);
    } else {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(mt.volume, t0 + fade);
      if (duration > fade * 2) {
        gain.gain.setValueAtTime(mt.volume, t0 + duration - fade);
        gain.gain.linearRampToValueAtTime(0, t0 + duration);
      }
    }
    src.connect(gain).connect(panner).connect(getMaster());
    src.start(t0, audioOffset, duration);
    mixerSources.push(src);
  }

  mixerPlaying = true;
  animFrame = requestAnimationFrame(animMixer);
  mixerPlayBtn.textContent = '⏸';
}

function stopMixer(resetPos) {
  mixerPlaying = false;
  cancelAnimationFrame(animFrame);
  if (!resetPos) {
    currentPlayhead = startPlayhead + (audioCtx?.currentTime ?? 0) - startCtxTime;
  } else {
    currentPlayhead = 0;
  }
  mixerSources.forEach(s => { try { s.stop(); } catch {} });
  mixerSources = [];
  updatePlayheadEl(currentPlayhead);
  updateMixerTimeDisplay();
  mixerPlayBtn.textContent = '▶';
}

function animMixer() {
  if (!mixerPlaying) return;
  const elapsed = audioCtx.currentTime - startCtxTime;
  const pos = startPlayhead + elapsed;
  updatePlayheadEl(pos);
  const total = getMixerDuration();
  mixerTimeEl.textContent = `${fmtTime(pos)} / ${fmtTime(total)}`;
  if (pos >= total + 0.05) {
    stopMixer(true);
    return;
  }
  animFrame = requestAnimationFrame(animMixer);
}

mixerPlayBtn.addEventListener('click', () => {
  if (!mixerTracks.length) return;
  if (mixerPlaying) stopMixer(false);
  else startMixer();
});
mixerStopBtn.addEventListener('click', () => stopMixer(true));

// ─────────────────────────────────────────────
// Export (WAV mix-down via OfflineAudioContext)
// ─────────────────────────────────────────────
mixerExportBtn.addEventListener('click', async () => {
  if (!mixerTracks.length) return;
  mixerExportBtn.disabled = true;
  mixerExportBtn.textContent = '로딩 중...';

  await Promise.all(
    mixerTracks.filter(mt => !mt.buffer).map(async mt => { mt.buffer = await loadBuffer(mt.id); })
  );

  mixerExportBtn.textContent = '렌더링 중...';
  const rendered = await renderMixdown();
  const blob = bufferToWav(rendered);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: 'mix.wav',
  });
  a.click();
  URL.revokeObjectURL(a.href);

  mixerExportBtn.textContent = '📥 내보내기';
  mixerExportBtn.disabled = false;
});

async function renderMixdown() {
  await Promise.all(
    mixerTracks.filter(mt => !mt.buffer && !mt.id.startsWith('rec_'))
      .map(async mt => { mt.buffer = await loadBuffer(mt.id); })
  );
  const total = getMixerDuration();
  if (total <= 0) throw new Error('믹서에 트랙이 없어요');
  const sr = 44100;
  const offCtx = new OfflineAudioContext(2, Math.ceil(total * sr) + sr, sr);

  const masterOut = offCtx.createGain();
  masterOut.gain.value = masterVolNode ? masterVolNode.gain.value : 0.9;
  const offLimiter = offCtx.createDynamicsCompressor();
  offLimiter.threshold.value = -3; offLimiter.knee.value = 3;
  offLimiter.ratio.value = 20; offLimiter.attack.value = 0.001; offLimiter.release.value = 0.1;
  masterOut.connect(offLimiter);
  offLimiter.connect(offCtx.destination);

  const fade = 0.04;
  for (const mt of mixerTracks) {
    if (!mt.buffer || mt.muted) continue;
    const delay = Math.max(0, mt.startOffset);
    const audioOffset = mt.trimStart;
    const duration = mt.trimEnd - audioOffset;
    if (duration <= 0) continue;
    const src = offCtx.createBufferSource();
    src.buffer = mt.buffer;
    const gain = offCtx.createGain();
    const panner = offCtx.createStereoPanner();
    panner.pan.value = mt.pan ?? 0;
    const t0 = delay;
    if (mt.automation?.length > 1) {
      const sorted = [...mt.automation].sort((a, b) => a.t - b.t);
      gain.gain.setValueAtTime(sorted[0].v * mt.volume, t0);
      for (const pt of sorted) gain.gain.linearRampToValueAtTime(pt.v * mt.volume, t0 + pt.t);
    } else {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(mt.volume, t0 + fade);
      if (duration > fade * 2) {
        gain.gain.setValueAtTime(mt.volume, t0 + duration - fade);
        gain.gain.linearRampToValueAtTime(0, t0 + duration);
      }
    }
    src.connect(gain).connect(panner).connect(masterOut);
    src.start(delay, audioOffset, duration);
  }
  return offCtx.startRendering();
}

function bufferToWav(buf) {
  const numCh = buf.numberOfChannels;
  const sr    = buf.sampleRate;
  const len   = buf.length;
  const view  = new DataView(new ArrayBuffer(44 + len * numCh * 2));
  const writeStr = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));

  writeStr(0, 'RIFF'); view.setUint32(4, 36 + len * numCh * 2, true);
  writeStr(8, 'WAVE'); writeStr(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, len * numCh * 2, true);

  const ch = Array.from({ length: numCh }, (_, i) => buf.getChannelData(i));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, ch[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

refreshMixerVisibility();

// ─────────────────────────────────────────────
// Sampler tab
// ─────────────────────────────────────────────
const padGrid = document.getElementById('pad-grid');

function renderPads() {
  padGrid.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const pad = pads[i];
    const el  = document.createElement('div');
    el.className = 'pad' + (pad ? ' assigned' : '');
    el.style.setProperty('--bc', `hsl(${Math.round(i * 31)}, 80%, 50%)`);
    el.innerHTML = pad
      ? `<span class="pad-num">${i + 1}</span>
         <span class="pad-icon">🎵</span>
         <span class="pad-name">${escHtml(pad.title)}</span>
         <button class="pad-settings-btn" aria-label="패드 설정">⚙</button>
         <button class="pad-clear-btn">✕</button>`
      : `<span class="pad-num">${i + 1}</span>
         <span class="pad-icon" style="opacity:.25">+</span>
         <span class="pad-empty">비어있음</span>`;

    let longPressTimer = null;
    let pressStart = null;
    el.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('pad-clear-btn') || e.target.classList.contains('pad-settings-btn')) return;
      if (e.button === 2) return; // right-click handled by contextmenu
      // 캡처: 손가락이 패드 밖으로 미끄러져도 pointerup을 이 패드가 받음 (홀드 정지 보장)
      try { el.setPointerCapture(e.pointerId); } catch {}
      triggerPad(i);
      // 길게 누르면 설정 — 홀드 모드는 길게 누르는 것 자체가 연주라 제외 (⚙ 버튼으로 진입)
      if (pads[i] && pads[i].padMode !== 'hold') {
        pressStart = { x: e.clientX, y: e.clientY };
        longPressTimer = setTimeout(() => openPadSettings(i), 600);
      }
    });
    el.addEventListener('pointermove', e => {
      // 8px 이상 움직이면 길게누르기 취소 (손떨림·드래그 오인 방지)
      if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 8) {
        clearTimeout(longPressTimer);
        pressStart = null;
      }
    });
    const endPress = () => {
      clearTimeout(longPressTimer);
      pressStart = null;
      if (pads[i]?.padMode === 'hold' && padSources[i]) {
        try { padSources[i].stop(); } catch {}
        padSources[i] = null;
      }
    };
    el.addEventListener('pointerup', endPress);
    el.addEventListener('pointercancel', endPress);
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (pad) openPadSettings(i);
    });
    el.querySelector('.pad-settings-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openPadSettings(i);
    });
    el.querySelector('.pad-clear-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      clearPad(i);
    });
    padGrid.appendChild(el);
  }
}

function triggerPad(idx) {
  const pad = pads[idx];
  if (!pad) return;

  const el = padGrid.children[idx];
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 130);

  if (padSources[idx]) {
    try { padSources[idx].stop(); } catch {}
    padSources[idx] = null;
  }

  if (!pad.buffer) {
    el.classList.add('loading');
    loadBuffer(pad.id).then(buf => {
      pad.buffer = buf;
      el.classList.remove('loading');
      playPad(idx);
    });
    return;
  }
  playPad(idx);
}

function playPad(idx) {
  const pad = pads[idx];
  if (!pad?.buffer) return;
  const ctx  = getCtx();
  const src  = ctx.createBufferSource();
  src.buffer = pad.buffer;
  src.playbackRate.value = Math.pow(2, (pad.padPitch || 0) / 12);
  if (pad.padMode === 'loop') { src.loop = true; }
  const gain = ctx.createGain();
  gain.gain.value = (pad.padVolume ?? 1) * 0.9;
  src.connect(gain).connect(getMaster());
  src.start();
  padSources[idx] = src;
  src.onended = () => { if (padSources[idx] === src) padSources[idx] = null; };
}

function clearPad(idx) {
  try { padSources[idx]?.stop(); } catch {}
  padSources[idx] = null;
  pads[idx] = null;
  renderPads();
  scheduleSave();
}

function addToPad(track) {
  const idx = pads.indexOf(null);
  if (idx === -1) {
    setStatus('패드가 모두 사용 중입니다', 'error');
    return;
  }
  pads[idx] = { id: track.id, title: track.title, duration: track.duration, buffer: null, padVolume: 1, padPitch: 0, padMode: 'oneshot' };
  renderPads();
  scheduleSave();
  document.querySelector('[data-tab="turntable"]').click();
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const n = parseInt(e.key);
  if (n >= 1 && n <= 9) triggerPad(n - 1);
});

renderPads();

// ─────────────────────────────────────────────
// Turntable
// ─────────────────────────────────────────────
const NORM_DEG_PER_SEC = 198; // 33 RPM
const MAX_SCRATCH_RATE = 4;

function makeDeck(idx) {
  return {
    idx,
    track: null, buffer: null, revBuffer: null,
    position: 0, duration: 0,
    gainNode: null, eqLow: null, eqMid: null, eqHigh: null,
    filterNode: null, crossNode: null,
    eqLowGain: 0, eqMidGain: 0, eqHighGain: 0, filterVal: 0,
    isPlaying: false, isReversed: false,
    baseRate: 1, targetRate: 1,
    source: null, startCtxTime: 0, startPos: 0,
    isDragging: false, wasPlaying: false,
    visualAngle: 0,
    loopActive: false, loopStart: 0, loopEnd: 0,
    hotCues: [null, null, null, null],
    bpm: null,
    keyLockEnabled: false, keyLockBuffer: null, keyLockProcessing: false,
  };
}

const decks = [makeDeck(0), makeDeck(1)];

function ensureDeckGain(d) {
  if (d.gainNode) return d.gainNode;
  const ctx = getCtx();
  d.gainNode = ctx.createGain();
  d.gainNode.gain.value = 0.8;

  d.eqLow = ctx.createBiquadFilter();
  d.eqLow.type = 'lowshelf';
  d.eqLow.frequency.value = 250;
  d.eqLow.gain.value = d.eqLowGain;

  d.eqMid = ctx.createBiquadFilter();
  d.eqMid.type = 'peaking';
  d.eqMid.frequency.value = 1200;
  d.eqMid.Q.value = 0.7;
  d.eqMid.gain.value = d.eqMidGain;

  d.eqHigh = ctx.createBiquadFilter();
  d.eqHigh.type = 'highshelf';
  d.eqHigh.frequency.value = 4000;
  d.eqHigh.gain.value = d.eqHighGain;

  d.filterNode = ctx.createBiquadFilter();
  d.filterNode.type = 'allpass';
  d.filterNode.frequency.value = 20000;

  // Echo (delay line with feedback)
  d.echoDelay = ctx.createDelay(2.0);
  d.echoDelay.delayTime.value = 0.375;
  d.echoFeedback = ctx.createGain();
  d.echoFeedback.gain.value = 0.35;
  d.echoWet = ctx.createGain();
  d.echoWet.gain.value = 0;

  // Reverb (convolver with generated impulse)
  d.reverb = ctx.createConvolver();
  d.reverb.buffer = getImpulseResponse(ctx);
  d.reverbWet = ctx.createGain();
  d.reverbWet.gain.value = 0;

  d.crossNode = ctx.createGain();
  d.crossNode.gain.value = 1;

  d.gainNode.connect(d.eqLow);
  d.eqLow.connect(d.eqMid);
  d.eqMid.connect(d.eqHigh);
  d.eqHigh.connect(d.filterNode);
  // dry path
  d.filterNode.connect(d.crossNode);
  // echo path
  d.filterNode.connect(d.echoDelay);
  d.echoDelay.connect(d.echoFeedback);
  d.echoFeedback.connect(d.echoDelay);
  d.echoDelay.connect(d.echoWet);
  d.echoWet.connect(d.crossNode);
  // reverb path
  d.filterNode.connect(d.reverb);
  d.reverb.connect(d.reverbWet);
  d.reverbWet.connect(d.crossNode);
  d.crossNode.connect(getMaster());

  applyDeckFilter(d, d.filterVal);
  return d.gainNode;
}

function getDeckPos(d) {
  if (!d.source || !d.isPlaying) return d.position;
  const elapsed = getCtx().currentTime - d.startCtxTime;
  const absRate = Math.abs(d.targetRate);
  if (d.isReversed) return Math.max(0, d.startPos - elapsed * absRate);
  let pos = d.startPos + elapsed * absRate;
  if (d.loopActive && d.loopEnd > d.loopStart && pos > d.loopEnd) {
    const len = d.loopEnd - d.loopStart;
    pos = d.loopStart + ((pos - d.loopStart) % len);
  }
  return Math.min(d.duration, pos);
}

function snapshotDeckPos(d) {
  d.position = getDeckPos(d);
  d.startCtxTime = getCtx().currentTime;
  d.startPos = d.position;
}

function reverseBuffer(buf) {
  const ctx = getCtx();
  const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = rev.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
  }
  return rev;
}

function stopDeckSource(d) {
  if (d.source) { try { d.source.stop(); } catch {} d.source = null; }
}

function startDeckSource(d) {
  stopDeckSource(d);
  if (!d.buffer) return;
  const absRate = Math.abs(d.targetRate);
  if (absRate < 0.01) return;
  const reversed = d.targetRate < 0;
  d.isReversed = reversed;
  // Key Lock: use pre-stretched buffer at 1x so pitch stays constant
  const useKL = d.keyLockEnabled && d.keyLockBuffer && !reversed && !d.isDragging;
  const buf = useKL ? d.keyLockBuffer : (reversed ? d.revBuffer : d.buffer);
  if (!buf) return;
  // When using KL buffer, position in original → position in stretched = pos/rate
  const posInBuf = useKL ? (d.position / d.baseRate) : d.position;
  let offset = reversed ? (buf.duration - d.position) : posInBuf;
  offset = Math.max(0, Math.min(offset, buf.duration - 0.001));
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = useKL ? 1 : absRate;
  if (!reversed && d.loopActive && d.loopEnd > d.loopStart) {
    src.loop = true;
    src.loopStart = d.loopStart;
    src.loopEnd = Math.min(d.loopEnd, buf.duration);
  }
  src.connect(ensureDeckGain(d));
  src.start(0, offset);
  d.source = src;
  d.startCtxTime = ctx.currentTime;
  d.startPos = d.position;
  src.onended = () => {
    if (d.source !== src) return;
    d.source = null;
    d.position = d.isReversed ? 0 : d.duration;
    d.isPlaying = false;
    updateDeckUI(d);
  };
}

function playDeck(d) {
  if (!d.buffer) return;
  if (d.position >= d.duration - 0.1) d.position = 0;
  d.isPlaying = true;
  d.targetRate = d.baseRate;
  d.isReversed = false;
  startDeckSource(d);
  updateDeckUI(d);
}

function pauseDeck(d) {
  snapshotDeckPos(d);
  d.isPlaying = false;
  stopDeckSource(d);
  updateDeckUI(d);
}

function deckEls(d) {
  // 덱 DOM은 정적이므로 한 번만 조회해서 캐싱 (매 프레임 querySelector 방지)
  if (!d._ui) {
    const container = document.querySelector(`.deck[data-deck="${d.idx}"]`);
    if (!container) return null;
    d._ui = {
      title:   container.querySelector('.deck-title-text'),
      pos:     container.querySelector('.deck-pos-text'),
      play:    container.querySelector('.deck-play-btn'),
      bpm:     container.querySelector('.deck-bpm-text'),
      loop:    container.querySelector('.loop-toggle'),
      cues:    [...container.querySelectorAll('.hotcue-btn')],
      disc:    document.querySelector(`.deck-disc[data-deck="${d.idx}"]`),
      vinyl:   null,
      canvas:  document.querySelector(`.deck-waveform[data-deck="${d.idx}"]`),
    };
    d._ui.vinyl = d._ui.disc?.querySelector('.vinyl-label');
  }
  return d._ui;
}

function updateDeckUI(d) {
  const ui = deckEls(d);
  if (!ui) return;
  ui.title.textContent = d.track ? d.track.title : '-';
  const pos = getDeckPos(d);
  ui.pos.textContent = `${fmtTime(pos)} / ${fmtTime(d.duration)}`;
  ui.play.textContent = d.isPlaying ? '⏸' : '▶';
  if (ui.bpm) ui.bpm.textContent = d.bpm ? `${d.bpm} BPM` : '-- BPM';
  if (ui.loop) ui.loop.classList.toggle('active', d.loopActive);
  ui.cues.forEach((btn, i) => {
    btn.classList.toggle('set', d.hotCues[i] !== null);
    btn.title = d.hotCues[i] !== null ? `${fmtTime(d.hotCues[i])} — 길게 눌러 삭제` : '현재 위치에 큐 설정';
  });
}

function assignToDeck(d, track) {
  pauseDeck(d);
  d.track = track;
  d.position = 0;
  d.duration = track.duration || 0;
  d.buffer = null;
  d.revBuffer = null;
  const disc = document.querySelector(`.deck-disc[data-deck="${d.idx}"]`);
  disc.classList.add('assigned');
  disc.querySelector('.dai').textContent = '🎵';
  disc.querySelector('.dan').textContent = track.title;
  updateDeckUI(d);
  d._waveformCache = null;
  d.bpm = null;
  loadBuffer(track.id).then(buf => {
    d.buffer = buf;
    d.duration = buf.duration;
    d.revBuffer = reverseBuffer(buf);
    d.loopEnd = buf.duration;
    buildWaveformCache(d);
    setTimeout(() => { d.bpm = estimateBpm(buf); updateDeckUI(d); }, 0);
    updateDeckUI(d);
  });
}

function setupDeckDrag(d) {
  const disc = document.querySelector(`.deck-disc[data-deck="${d.idx}"]`);
  const badge = disc.querySelector('.deck-speed-badge');
  let prevAngle = 0, prevTime = 0;

  disc.addEventListener('pointerdown', e => {
    if (e.target.closest('.deck-assign-btn')) return;
    if (!d.buffer) return;
    if (e.button === 2) return;
    e.preventDefault();
    const rect = disc.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    prevAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    prevTime = performance.now();
    d.wasPlaying = d.isPlaying;
    d.isDragging = true;
    disc.classList.add('dragging');
    snapshotDeckPos(d);
    stopDeckSource(d);

    const onMove = ev => {
      const r = disc.getBoundingClientRect();
      const angle = Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
      const now = performance.now();
      const dt = Math.max(now - prevTime, 1) / 1000;
      let delta = angle - prevAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      const angVel = delta / dt;
      prevAngle = angle; prevTime = now;

      d.visualAngle = (d.visualAngle + delta + 360) % 360;
      disc.style.transform = `rotate(${d.visualAngle}deg)`;
      disc.querySelector('.vinyl-label').style.transform = `rotate(-${d.visualAngle}deg)`;

      const rate = Math.max(-MAX_SCRATCH_RATE, Math.min(MAX_SCRATCH_RATE, angVel / NORM_DEG_PER_SEC));
      const absRate = Math.abs(rate);
      const reversed = rate < 0;

      d.position = Math.max(0, Math.min(d.duration, d.position + rate * dt));

      if (reversed !== d.isReversed) {
        d.targetRate = rate;
        if (absRate > 0.01) startDeckSource(d);
        else stopDeckSource(d);
      } else if (d.source && absRate > 0.01) {
        d.source.playbackRate.value = absRate;
        d.targetRate = rate;
        d.startCtxTime = getCtx().currentTime;
        d.startPos = d.position;
      } else if (absRate > 0.01) {
        d.targetRate = rate;
        startDeckSource(d);
      } else {
        stopDeckSource(d);
        d.targetRate = 0;
      }

      badge.textContent = absRate < 0.05
        ? '⏸ 0.0x'
        : `${rate < 0 ? '◀' : '▶'} ${absRate.toFixed(1)}x`;
      updateDeckUI(d);
    };

    const onUp = () => {
      d.isDragging = false;
      disc.classList.remove('dragging');
      snapshotDeckPos(d);
      stopDeckSource(d);
      if (d.wasPlaying) {
        d.isPlaying = true;
        d.targetRate = d.baseRate;
        d.isReversed = false;
        startDeckSource(d);
      }
      updateDeckUI(d);
    };

    trackPointer(e, onMove, onUp);
  });
}

document.querySelectorAll('.vol-vertical').forEach(slider => {
  slider.addEventListener('input', e => {
    const d = decks[+e.target.dataset.deck];
    if (d) ensureDeckGain(d).gain.value = +e.target.value;
  });
});

document.querySelectorAll('.deck-play-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = decks[+btn.dataset.deck];
    if (!d) return;
    if (d.isPlaying) pauseDeck(d); else playDeck(d);
  });
});

document.querySelectorAll('.deck-pitch-slider').forEach(slider => {
  const valEl = slider.closest('.deck-pitch-row')?.querySelector('.deck-pitch-val');
  slider.addEventListener('input', () => {
    const d = decks[+slider.dataset.deck];
    if (!d) return;
    const rate = +slider.value;
    d.baseRate = rate;
    d.keyLockBuffer = null; // invalidate old KL buffer on rate change
    if (valEl) valEl.textContent = rate.toFixed(2) + 'x';
    if (d.isPlaying && !d.isDragging) {
      snapshotDeckPos(d);
      d.targetRate = rate;
      d.isReversed = false;
      startDeckSource(d);
    }
  });
  slider.addEventListener('change', () => {
    const d = decks[+slider.dataset.deck];
    if (!d || !d.keyLockEnabled) return;
    processKeyLock(d);
  });
});

let pickerTargetDeck = null;
const pickerEl = document.getElementById('track-picker');
const pickerList = document.getElementById('picker-list');

document.querySelectorAll('.deck-assign-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    pickerTargetDeck = decks[+btn.dataset.deck];
    pickerList.innerHTML = '';
    if (!tracks.length) {
      pickerList.innerHTML = '<li style="color:var(--muted);font-size:.82rem;padding:10px">추출된 트랙이 없어요</li>';
    }
    tracks.forEach(t => {
      const li = document.createElement('li');
      li.className = 'picker-item';
      li.innerHTML = `<span>${escHtml(t.title)}</span><span class="picker-dur">${fmtTime(t.duration)}</span>`;
      li.addEventListener('click', () => {
        if (pickerTargetDeck) assignToDeck(pickerTargetDeck, t);
        pickerEl.style.display = 'none';
      });
      pickerList.appendChild(li);
    });
    pickerEl.style.display = 'flex';
  });
});
document.getElementById('picker-cancel').addEventListener('click', () => { pickerEl.style.display = 'none'; });
pickerEl.addEventListener('click', e => { if (e.target === pickerEl) pickerEl.style.display = 'none'; });

let prevDeckRaf = null;
(function animDecks(ts) {
  const dt = prevDeckRaf ? (ts - prevDeckRaf) / 1000 : 0;
  prevDeckRaf = ts;
  for (const d of decks) {
    if (!d.isPlaying || d.isDragging) continue;
    const ui = deckEls(d);
    if (!ui?.disc) continue;
    const dir = d.isReversed ? -1 : 1;
    d.visualAngle = (d.visualAngle + dir * NORM_DEG_PER_SEC * Math.abs(d.targetRate || 1) * dt + 360) % 360;
    ui.disc.style.transform = `rotate(${d.visualAngle}deg)`;
    ui.vinyl.style.transform = `rotate(-${d.visualAngle}deg)`;
    updateDeckUI(d);
    drawWaveform(d);
  }
  requestAnimationFrame(animDecks);
})(0);

decks.forEach(d => setupDeckDrag(d));

// ─────────────────────────────────────────────
// Waveform
// ─────────────────────────────────────────────
const HOT_CUE_COLORS = ['#4af', '#f4a', '#af4', '#fa4'];

function buildWaveformCache(d) {
  const canvas = deckEls(d)?.canvas;
  if (!canvas || !d.buffer) return;
  canvas.width = canvas.offsetWidth || 400;
  const W = canvas.width, H = canvas.height;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const oc = off.getContext('2d');
  const data = d.buffer.getChannelData(0);
  const step = Math.ceil(data.length / W);
  oc.fillStyle = '#050507';
  oc.fillRect(0, 0, W, H);
  oc.fillStyle = '#1a3a5a';
  for (let x = 0; x < W; x++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[x * step + j] || 0);
      if (v > max) max = v;
    }
    const h = max * H;
    oc.fillRect(x, (H - h) / 2, 1, Math.max(1, h));
  }
  d._waveformCache = off;
}

function drawWaveform(d) {
  const canvas = deckEls(d)?.canvas;
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!d._waveformCache) {
    ctx2d.fillStyle = '#050507';
    ctx2d.fillRect(0, 0, W, H);
    return;
  }
  ctx2d.drawImage(d._waveformCache, 0, 0);
  if (d.duration <= 0) return;
  // loop region
  if (d.loopActive && d.loopEnd > d.loopStart) {
    const x1 = Math.round(d.loopStart / d.duration * W);
    const x2 = Math.round(d.loopEnd / d.duration * W);
    ctx2d.fillStyle = 'rgba(68,170,255,0.18)';
    ctx2d.fillRect(x1, 0, x2 - x1, H);
    ctx2d.fillStyle = '#4af';
    ctx2d.fillRect(x1, 0, 1, H);
    ctx2d.fillRect(x2, 0, 1, H);
  }
  // hot cues
  d.hotCues.forEach((cue, i) => {
    if (cue === null) return;
    const cx = Math.round(cue / d.duration * W);
    ctx2d.fillStyle = HOT_CUE_COLORS[i];
    ctx2d.fillRect(cx, 0, 2, H);
  });
  // playhead
  const px = Math.round(getDeckPos(d) / d.duration * W);
  ctx2d.fillStyle = '#fff';
  ctx2d.fillRect(px, 0, 2, H);
}

// ─────────────────────────────────────────────
// BPM detection
// ─────────────────────────────────────────────
function estimateBpm(buf) {
  const sr = buf.sampleRate;
  const data = buf.getChannelData(0);
  const len = Math.min(data.length, sr * 90);
  const winSize = Math.round(sr * 0.04);
  const hop = Math.round(winSize / 2);
  const energies = [];
  for (let i = 0; i + winSize < len; i += hop) {
    let e = 0;
    for (let j = 0; j < winSize; j++) e += data[i + j] ** 2;
    energies.push(e / winSize);
  }
  const wLen = 20;
  const onsets = [];
  let winSum = 0;
  for (let i = 0; i < wLen && i < energies.length; i++) winSum += energies[i];
  for (let i = wLen; i < energies.length - 1; i++) {
    const mean = winSum / wLen;
    if (energies[i] > mean * 1.4 && energies[i] > energies[i - 1] && energies[i] >= energies[i + 1]) {
      if (!onsets.length || (i - onsets[onsets.length - 1]) * hop / sr > 0.1) onsets.push(i);
    }
    winSum += energies[i] - energies[i - wLen];
  }
  if (onsets.length < 4) return null;
  const hist = {};
  for (let i = 1; i < Math.min(onsets.length, 300); i++) {
    const iv = (onsets[i] - onsets[i - 1]) * hop / sr;
    if (iv < 0.25 || iv > 2) continue;
    const bpm = Math.round(60 / iv);
    if (bpm < 60 || bpm > 200) continue;
    const k = Math.round(bpm / 2) * 2;
    hist[k] = (hist[k] || 0) + 1;
  }
  let best = null, bestN = 0;
  for (const [b, n] of Object.entries(hist)) { if (n > bestN) { bestN = n; best = +b; } }
  return best;
}

// ─────────────────────────────────────────────
// EQ & Filter
// ─────────────────────────────────────────────
function applyDeckFilter(d, val) {
  d.filterVal = val;
  if (!d.filterNode) return;
  if (val < -0.05) {
    d.filterNode.type = 'lowpass';
    d.filterNode.frequency.value = 200 * Math.pow(100, val + 1);
  } else if (val > 0.05) {
    d.filterNode.type = 'highpass';
    d.filterNode.frequency.value = 20 * Math.pow(400, val);
  } else {
    d.filterNode.type = 'allpass';
    d.filterNode.frequency.value = 20000;
  }
}

document.querySelectorAll('.eq-slider').forEach(sl => {
  sl.addEventListener('input', () => {
    const d = decks[+sl.dataset.deck];
    const v = +sl.value;
    if (sl.dataset.band === 'low') { d.eqLowGain = v; if (d.eqLow) d.eqLow.gain.value = v; }
    else if (sl.dataset.band === 'mid') { d.eqMidGain = v; if (d.eqMid) d.eqMid.gain.value = v; }
    else { d.eqHighGain = v; if (d.eqHigh) d.eqHigh.gain.value = v; }
  });
});

document.querySelectorAll('.eq-kill').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = decks[+btn.dataset.deck];
    const band = btn.dataset.band;
    const sl = document.querySelector(`.eq-slider[data-deck="${d.idx}"][data-band="${band}"]`);
    const killing = btn.classList.toggle('active');
    const v = killing ? -40 : 0;
    if (sl) sl.value = v;
    if (band === 'low') { d.eqLowGain = v; if (d.eqLow) d.eqLow.gain.value = v; }
    else if (band === 'mid') { d.eqMidGain = v; if (d.eqMid) d.eqMid.gain.value = v; }
    else { d.eqHighGain = v; if (d.eqHigh) d.eqHigh.gain.value = v; }
  });
});

document.querySelectorAll('.filter-slider').forEach(sl => {
  sl.addEventListener('input', () => applyDeckFilter(decks[+sl.dataset.deck], +sl.value));
});

// ─────────────────────────────────────────────
// Crossfader
// ─────────────────────────────────────────────
function updateCrossfader(t) {
  const gA = Math.cos(t * Math.PI / 2);
  const gB = Math.sin(t * Math.PI / 2);
  ensureDeckGain(decks[0]); ensureDeckGain(decks[1]);
  if (decks[0].crossNode) decks[0].crossNode.gain.value = gA;
  if (decks[1].crossNode) decks[1].crossNode.gain.value = gB;
}
document.getElementById('crossfader').addEventListener('input', e => updateCrossfader(+e.target.value));

// ─────────────────────────────────────────────
// Loop controls
// ─────────────────────────────────────────────
document.querySelectorAll('.loop-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = decks[+btn.dataset.deck];
    const action = btn.dataset.action;
    if (action === 'in') {
      d.loopStart = getDeckPos(d);
      if (d.loopStart >= d.loopEnd) d.loopEnd = Math.min(d.duration, d.loopStart + 4);
    } else if (action === 'out') {
      const pos = getDeckPos(d);
      if (pos > d.loopStart) {
        d.loopEnd = pos;
        if (!d.loopActive) {
          d.loopActive = true;
          if (d.isPlaying && !d.isDragging) { snapshotDeckPos(d); startDeckSource(d); }
        }
      }
    } else {
      d.loopActive = !d.loopActive;
      if (d.isPlaying && !d.isDragging) { snapshotDeckPos(d); startDeckSource(d); }
    }
    updateDeckUI(d);
  });
});

// ─────────────────────────────────────────────
// Hot cues
// ─────────────────────────────────────────────
document.querySelectorAll('.hotcue-btn').forEach(btn => {
  let pressTimer = null;
  let longPressFired = false;
  btn.addEventListener('pointerdown', e => {
    if (e.button === 2) return;
    longPressFired = false;
    pressTimer = setTimeout(() => {
      longPressFired = true;
      const d = decks[+btn.dataset.deck];
      d.hotCues[+btn.dataset.cue] = null;
      updateDeckUI(d);
      drawWaveform(d);
    }, 600);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  btn.addEventListener('pointerup', cancelPress);
  btn.addEventListener('pointercancel', cancelPress);
  btn.addEventListener('pointerleave', cancelPress);
  btn.addEventListener('click', () => {
    // 길게 눌러 삭제한 직후의 click이 큐를 곧바로 재설정하지 않도록
    if (longPressFired) { longPressFired = false; return; }
    const d = decks[+btn.dataset.deck];
    const ci = +btn.dataset.cue;
    if (d.hotCues[ci] === null) {
      d.hotCues[ci] = getDeckPos(d);
    } else {
      snapshotDeckPos(d);
      d.position = d.hotCues[ci];
      if (d.isPlaying) startDeckSource(d);
    }
    updateDeckUI(d);
    drawWaveform(d);
  });
});

// ─────────────────────────────────────────────
// BPM Sync
// ─────────────────────────────────────────────
document.querySelectorAll('.deck-sync-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const idx = +btn.dataset.deck;
    const d = decks[idx];
    const other = decks[1 - idx];
    if (!d.bpm || !other.bpm) { setStatus('BPM 감지 필요 (곡 로딩 후 자동 감지)', 'error'); return; }
    const newRate = other.bpm / d.bpm;
    d.baseRate = Math.max(0.5, Math.min(2, newRate));
    const sl = document.querySelector(`.deck-pitch-slider[data-deck="${idx}"]`);
    const val = document.querySelector(`.deck-pitch-val`);
    if (sl) { sl.value = d.baseRate; sl.closest('.deck-pitch-row').querySelector('.deck-pitch-val').textContent = d.baseRate.toFixed(2) + 'x'; }
    if (d.isPlaying && !d.isDragging) { snapshotDeckPos(d); d.targetRate = d.baseRate; d.isReversed = false; startDeckSource(d); }
    setStatus(`덱 ${idx + 1} → ${d.baseRate.toFixed(2)}x (${other.bpm} BPM 맞춤)`, 'success');
  });
});

// ─────────────────────────────────────────────
// Playlist
// ─────────────────────────────────────────────
const playlist = [];
let plIndex = -1;

const plEmpty  = document.getElementById('pl-empty');
const plListEl = document.getElementById('pl-list');
const plNow    = document.getElementById('pl-now');
const plAudio  = document.getElementById('pl-audio');
const plLabel  = document.getElementById('pl-label');

function addToPlaylist(track) {
  if (playlist.find(t => t.id === track.id)) {
    setStatus(`"${track.title}" 이미 플레이리스트에 있어요`, 'error');
    return;
  }
  playlist.push(track);
  renderPlaylist();
  scheduleSave();
  document.querySelector('[data-tab="playlist"]').click();
}

function removeFromPlaylist(idx) {
  if (plIndex === idx) { plAudio.pause(); plNow.style.display = 'none'; plIndex = -1; }
  else if (plIndex > idx) plIndex--;
  playlist.splice(idx, 1);
  renderPlaylist();
  scheduleSave();
}

function renderPlaylist() {
  plListEl.innerHTML = '';
  const empty = playlist.length === 0;
  plEmpty.style.display = empty ? '' : 'none';
  plListEl.style.display = empty ? 'none' : '';
  playlist.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'pl-item' + (i === plIndex ? ' pl-active' : '');
    li.innerHTML = `
      <span class="pl-num">${i + 1}</span>
      <span class="pl-title">${escHtml(t.title)}</span>
      <span class="pl-dur">${fmtTime(t.duration)}</span>
      <button class="pl-rm" aria-label="제거">✕</button>
    `;
    li.querySelector('.pl-rm').addEventListener('click', e => { e.stopPropagation(); removeFromPlaylist(i); });
    li.addEventListener('click', e => { if (!e.target.classList.contains('pl-rm')) playPlaylistTrack(i); });
    plListEl.appendChild(li);
  });
}

function playPlaylistTrack(idx) {
  if (idx < 0 || idx >= playlist.length) return;
  plIndex = idx;
  const t = playlist[idx];
  plAudio.src = t.stream_url;
  plAudio.play();
  plNow.style.display = '';
  plLabel.textContent = `▶ ${t.title}`;
  renderPlaylist();
}

plAudio.addEventListener('ended', () => {
  if (plIndex + 1 < playlist.length) playPlaylistTrack(plIndex + 1);
  else { plIndex = -1; plNow.style.display = 'none'; renderPlaylist(); }
});

document.getElementById('pl-play').addEventListener('click', () => {
  if (plAudio.src && plAudio.paused && plIndex >= 0) plAudio.play();
  else if (playlist.length > 0) playPlaylistTrack(Math.max(0, plIndex));
});
document.getElementById('pl-stop').addEventListener('click', () => {
  plAudio.pause(); plAudio.currentTime = 0;
  plNow.style.display = 'none'; plIndex = -1; renderPlaylist();
});
document.getElementById('pl-clear').addEventListener('click', () => {
  plAudio.pause(); playlist.length = 0; plIndex = -1;
  plNow.style.display = 'none'; renderPlaylist(); scheduleSave();
});

renderPlaylist();

// ─────────────────────────────────────────────
// Recording (AudioWorklet — audio 스레드에서 무손실 PCM 캡처)
// ─────────────────────────────────────────────
const REC_WORKLET_SRC = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._rec = false;
    this.port.onmessage = ({ data }) => { this._rec = data === 'start'; };
  }
  process(inputs) {
    if (!this._rec) return true;
    const input = inputs[0];
    if (!input || !input.length) return true;
    // Transfer ownership to avoid copy on main thread
    const out = [];
    const transferables = [];
    for (const ch of input) {
      const copy = new Float32Array(ch); // ch is a 128-sample view
      out.push(copy);
      transferables.push(copy.buffer);
    }
    this.port.postMessage(out, transferables);
    return true; // keep processor alive
  }
}
registerProcessor('yc-recorder', RecorderProcessor);
`;

let recWorkletReady = false;
let recWorkletNode  = null;
let pcmChunks       = null; // pcmChunks[chIdx] = Float32Array[]
let recTimer        = null;
let recSec          = 0;
let isRecording     = false;

const recBtn    = document.getElementById('rec-btn');
const recStatus = document.getElementById('rec-status');

// 'worklet' | 'scriptprocessor' | false
let recBackend = null;

async function ensureRecorderWorklet() {
  if (recBackend) return recBackend;
  const ctx = getCtx();
  if (ctx.audioWorklet && window.isSecureContext) {
    const blob = new Blob([REC_WORKLET_SRC], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
      recWorkletReady = true;
      recBackend = 'worklet';
      return recBackend;
    } catch (e) {
      console.warn('AudioWorklet 로드 실패, ScriptProcessor로 대체:', e);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // HTTP(비보안) 환경 fallback — ScriptProcessorNode
  if (ctx.createScriptProcessor) {
    recBackend = 'scriptprocessor';
    return recBackend;
  }
  return false;
}

async function startRecording() {
  const ctx = getCtx();
  getMaster();
  if (!masterAnalyser) return;

  const backend = await ensureRecorderWorklet();
  if (!backend) { setStatus('오디오 녹음이 지원되지 않는 환경입니다', 'error'); return; }

  pcmChunks = [];

  if (backend === 'worklet') {
    recWorkletNode = new AudioWorkletNode(ctx, 'yc-recorder', {
      numberOfInputs:    1,
      numberOfOutputs:   1,
      outputChannelCount: [2],
    });
    recWorkletNode.port.onmessage = ({ data: channels }) => {
      if (!pcmChunks) return;
      channels.forEach((ch, i) => {
        if (!pcmChunks[i]) pcmChunks[i] = [];
        pcmChunks[i].push(ch);
      });
    };
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    recWorkletNode.connect(silentGain);
    silentGain.connect(ctx.destination);
    recWorkletNode._sink = silentGain;
    masterAnalyser.connect(recWorkletNode);
    recWorkletNode.port.postMessage('start');
  } else {
    // ScriptProcessorNode fallback (HTTP / 구형 브라우저)
    recWorkletNode = ctx.createScriptProcessor(4096, 2, 2);
    recWorkletNode._isScript = true;
    recWorkletNode.onaudioprocess = e => {
      if (!pcmChunks) return;
      [0, 1].forEach(i => {
        if (!pcmChunks[i]) pcmChunks[i] = [];
        pcmChunks[i].push(new Float32Array(e.inputBuffer.getChannelData(i)));
      });
    };
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    recWorkletNode.connect(silentGain);
    silentGain.connect(ctx.destination);
    recWorkletNode._sink = silentGain;
    masterAnalyser.connect(recWorkletNode);
  }

  isRecording = true;
  recSec = 0;
  recTimer = setInterval(() => { recSec++; recStatus.textContent = fmtTime(recSec); }, 1000);
  recBtn.classList.add('recording');
  recBtn.textContent = '⏹ 정지';
}

function stopRecording() {
  clearInterval(recTimer);
  recStatus.textContent = '';
  recBtn.classList.remove('recording');
  recBtn.textContent = '⏺ REC';
  isRecording = false;

  if (!recWorkletNode) return;
  if (!recWorkletNode._isScript) recWorkletNode.port.postMessage('stop');
  try { masterAnalyser.disconnect(recWorkletNode); } catch {}
  try { recWorkletNode.disconnect(); } catch {}
  try { recWorkletNode._sink?.disconnect(); } catch {}
  recWorkletNode = null;

  if (!pcmChunks?.length || !pcmChunks[0]?.length) { pcmChunks = null; return; }

  const ctx    = getCtx();
  const numCh  = pcmChunks.length;
  const totLen = pcmChunks[0].reduce((s, b) => s + b.length, 0);
  const audioBuf = ctx.createBuffer(numCh, totLen, ctx.sampleRate);
  for (let c = 0; c < numCh; c++) {
    let off = 0;
    for (const chunk of pcmChunks[c]) { audioBuf.getChannelData(c).set(chunk, off); off += chunk.length; }
  }
  pcmChunks = null;

  const name   = `녹음 ${new Date().toLocaleTimeString('ko')}`;
  const id     = 'rec_' + Date.now();
  const wavBlob = bufferToWav(audioBuf);
  const wavUrl  = URL.createObjectURL(wavBlob);
  addTrackToList({ id, title: name, duration: audioBuf.duration,
    stream_url: wavUrl, download_url: wavUrl, _buffer: audioBuf });
  setStatus(`"${name}" 추출 탭에 추가됨 — 믹서에 올려보세요`, 'success');
  document.querySelector('[data-tab="extract"]').click();
}

recBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// ─────────────────────────────────────────────
// Project save / restore (localStorage)
// ─────────────────────────────────────────────
const SAVE_KEY = 'yohancode_music_v1';
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 600);
}

function saveProject() {
  const state = {
    mixer: mixerTracks.filter(mt => !mt.id.startsWith('rec_')).map(mt => ({
      id: mt.id, startOffset: mt.startOffset,
      trimStart: mt.trimStart, trimEnd: mt.trimEnd,
      volume: mt.volume, muted: mt.muted, color: mt.color,
      pan: mt.pan ?? 0, automation: mt.automation ?? [],
    })),
    pads: pads.map(p => (p && !p.id.startsWith('rec_'))
      ? { id: p.id, padVolume: p.padVolume ?? 1, padPitch: p.padPitch ?? 0, padMode: p.padMode ?? 'oneshot' }
      : null),
    playlist: playlist.filter(t => !t.id.startsWith('rec_')).map(t => t.id),
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  const ind = document.getElementById('save-indicator');
  if (ind) { ind.style.opacity = '1'; setTimeout(() => { ind.style.opacity = '0'; }, 1400); }
}

function restoreProject() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return;
  let state;
  try { state = JSON.parse(raw); } catch { return; }

  (state.mixer || []).forEach(saved => {
    const track = tracks.find(t => t.id === saved.id);
    if (!track || mixerTracks.find(m => m.id === saved.id)) return;
    const mt = {
      id: saved.id, title: track.title,
      duration: track.duration || 180, buffer: null,
      startOffset: saved.startOffset,
      trimStart: saved.trimStart, trimEnd: saved.trimEnd,
      volume: saved.volume, muted: !!saved.muted, color: saved.color,
      pan: saved.pan ?? 0, automation: saved.automation ?? [],
      blockEl: null, laneEl: null,
    };
    mixerTracks.push(mt);
    loadBuffer(track.id).then(buf => {
      mt.buffer = buf; mt.duration = buf.duration;
      updateBlockGeometry(mt);
    });
    renderMixerTrack(mt);
  });
  if (mixerTracks.length) { buildRuler(); refreshMixerVisibility(); }

  (state.pads || []).forEach((saved, i) => {
    if (!saved) return;
    const id = typeof saved === 'string' ? saved : saved.id;
    const t = tracks.find(tr => tr.id === id);
    if (t && !pads[i]) pads[i] = {
      id: t.id, title: t.title, duration: t.duration, buffer: null,
      padVolume: saved.padVolume ?? 1, padPitch: saved.padPitch ?? 0, padMode: saved.padMode ?? 'oneshot',
    };
  });
  renderPads();

  (state.playlist || []).forEach(id => {
    const t = tracks.find(tr => tr.id === id);
    if (t && !playlist.find(p => p.id === id)) playlist.push(t);
  });
  renderPlaylist();
}

// ─────────────────────────────────────────────
// Echo / Reverb FX handlers
// ─────────────────────────────────────────────
document.querySelectorAll('.echo-slider').forEach(sl => {
  sl.addEventListener('input', () => {
    const d = decks[+sl.dataset.deck];
    if (!d.echoWet) { ensureDeckGain(d); }
    if (d.echoWet) d.echoWet.gain.value = +sl.value;
    const valEl = sl.closest('.fx-group')?.querySelector('.fx-val');
    if (valEl) valEl.textContent = Math.round(sl.value * 100) + '%';
  });
});
document.querySelectorAll('.reverb-slider').forEach(sl => {
  sl.addEventListener('input', () => {
    const d = decks[+sl.dataset.deck];
    if (!d.reverbWet) { ensureDeckGain(d); }
    if (d.reverbWet) d.reverbWet.gain.value = +sl.value;
    const valEl = sl.closest('.fx-group')?.querySelector('.fx-val');
    if (valEl) valEl.textContent = Math.round(sl.value * 100) + '%';
  });
});

// ─────────────────────────────────────────────
// Master volume
// ─────────────────────────────────────────────
document.getElementById('master-vol').addEventListener('input', e => {
  getMaster();
  if (masterVolNode) masterVolNode.gain.value = +e.target.value;
  document.getElementById('master-vol-val').textContent = (+e.target.value).toFixed(2);
});

// ─────────────────────────────────────────────
// VU meter + Spectrum
// ─────────────────────────────────────────────
const vuCanvas = document.getElementById('vu-canvas');
const specCanvas = document.getElementById('spectrum-canvas');

let meterBufs = null; // 프레임마다 재할당하지 않도록 재사용

(function animMeters() {
  if (masterAnalyser) {
    const bufLen = masterAnalyser.frequencyBinCount;
    if (!meterBufs || meterBufs.time.length !== bufLen) {
      meterBufs = { time: new Uint8Array(bufLen), freq: new Uint8Array(bufLen) };
    }
    const timeData = meterBufs.time;
    const freqData = meterBufs.freq;
    masterAnalyser.getByteTimeDomainData(timeData);
    masterAnalyser.getByteFrequencyData(freqData);

    if (vuCanvas) {
      const c = vuCanvas.getContext('2d');
      const W = vuCanvas.width, H = vuCanvas.height;
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / timeData.length);
      const lvl = Math.min(1, rms * 7);
      c.fillStyle = '#050507'; c.fillRect(0, 0, W, H);
      const bH = Math.round(lvl * H);
      c.fillStyle = lvl < 0.6 ? '#2a5' : lvl < 0.85 ? '#fa0' : '#f00';
      c.fillRect(0, H - bH, W, bH);
    }

    if (specCanvas) {
      const c = specCanvas.getContext('2d');
      const W = specCanvas.width, H = specCanvas.height;
      c.fillStyle = '#050507'; c.fillRect(0, 0, W, H);
      const bars = 20;
      const bw = W / bars - 1;
      const step = Math.floor(freqData.length / bars);
      for (let i = 0; i < bars; i++) {
        let val = 0;
        for (let j = 0; j < step; j++) val += freqData[i * step + j];
        val /= step * 255;
        const bH = Math.round(val * H);
        c.fillStyle = `hsl(${(i / bars) * 220}, 80%, 50%)`;
        c.fillRect(i * (bw + 1), H - bH, bw, bH);
      }
    }
  }
  requestAnimationFrame(animMeters);
})();

// ─────────────────────────────────────────────
// Grid snap
// ─────────────────────────────────────────────
let snapEnabled = false;
const snapBtn = document.getElementById('snap-toggle');
snapBtn.addEventListener('click', () => {
  snapEnabled = !snapEnabled;
  snapBtn.classList.toggle('active', snapEnabled);
});

// ─────────────────────────────────────────────
// MP3 export
// ─────────────────────────────────────────────
function floatTo16Bit(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}

document.getElementById('mixer-mp3').addEventListener('click', async () => {
  if (!mixerTracks.length) { setStatus('믹서에 트랙이 없어요', 'error'); return; }
  if (typeof lamejs === 'undefined') { setStatus('MP3 라이브러리 로딩 실패 (인터넷 연결 확인)', 'error'); return; }

  setStatus('MP3 렌더링 중...', '');
  const btn = document.getElementById('mixer-mp3');
  btn.disabled = true;

  try {
    const rendered = await renderMixdown();
    const left = rendered.getChannelData(0);
    const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
    const l16 = floatTo16Bit(left), r16 = floatTo16Bit(right);
    const enc = new lamejs.Mp3Encoder(2, rendered.sampleRate, 192);
    const BLOCK = 1152;
    const chunks = [];
    for (let i = 0; i < l16.length; i += BLOCK) {
      const buf = enc.encodeBuffer(l16.subarray(i, i + BLOCK), r16.subarray(i, i + BLOCK));
      if (buf.length) chunks.push(new Uint8Array(buf));
    }
    const end = enc.flush();
    if (end.length) chunks.push(new Uint8Array(end));
    const blob = new Blob(chunks, { type: 'audio/mp3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mix_${Date.now()}.mp3`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`MP3 완료 (${(blob.size / 1024 / 1024).toFixed(1)} MB)`, 'success');
  } catch (err) {
    setStatus('MP3 실패: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ─────────────────────────────────────────────
// Key Lock (Master Tempo) — OLA time-stretch via Web Worker
// ─────────────────────────────────────────────
const KL_WORKER_SRC = `
self.onmessage = function({data: {channels, rate, numSamples}}) {
  if (Math.abs(rate - 1) < 0.005) { self.postMessage({result: channels}); return; }
  const WIN = 1024, HOP_IN = 256;
  const HOP_OUT = Math.max(1, Math.round(HOP_IN / rate));
  const outLen = Math.max(1, Math.round(numSamples / rate));
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos(6.2831853 * i / WIN));
  const result = [];
  for (const inp of channels) {
    const out = new Float32Array(outLen);
    const norm = new Float32Array(outLen);
    let iPos = 0, oPos = 0;
    while (iPos + WIN <= numSamples && oPos + WIN <= outLen) {
      for (let i = 0; i < WIN; i++) {
        const end = oPos + i;
        if (end < outLen) { out[end] += inp[iPos + i] * hann[i]; norm[end] += hann[i] * hann[i]; }
      }
      iPos += HOP_IN; oPos += HOP_OUT;
    }
    for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
    result.push(out);
  }
  self.postMessage({result}, result.map(r => r.buffer));
};
`;
const klWorkerUrl = URL.createObjectURL(new Blob([KL_WORKER_SRC], {type: 'application/javascript'}));

function processKeyLock(d) {
  if (!d.buffer || !d.keyLockEnabled) { d.keyLockBuffer = null; return; }
  if (Math.abs(d.baseRate - 1) < 0.005) { d.keyLockBuffer = null; return; }
  d.keyLockProcessing = true;
  setStatus(`덱 ${d.idx + 1} Key Lock 처리 중…`, 'info');
  const worker = new Worker(klWorkerUrl);
  const channels = [];
  for (let c = 0; c < d.buffer.numberOfChannels; c++)
    channels.push(d.buffer.getChannelData(c).slice());
  worker.onmessage = ({data: {result}}) => {
    const ctx = getCtx();
    const buf = ctx.createBuffer(result.length, result[0].length, ctx.sampleRate);
    for (let c = 0; c < result.length; c++) buf.getChannelData(c).set(result[c]);
    d.keyLockBuffer = buf;
    d.keyLockProcessing = false;
    worker.terminate();
    setStatus(`덱 ${d.idx + 1} Key Lock 완료`, 'success');
    if (d.isPlaying) { snapshotDeckPos(d); d.targetRate = d.baseRate; startDeckSource(d); }
  };
  worker.postMessage({channels, rate: d.baseRate, numSamples: d.buffer.length},
    channels.map(c => c.buffer));
}

document.querySelectorAll('.deck-kl-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const d = decks[+btn.dataset.deck];
    if (!d) return;
    d.keyLockEnabled = !d.keyLockEnabled;
    btn.classList.toggle('active', d.keyLockEnabled);
    if (d.keyLockEnabled) processKeyLock(d);
    else { d.keyLockBuffer = null; if (d.isPlaying) { snapshotDeckPos(d); startDeckSource(d); } }
  });
});

// ─────────────────────────────────────────────
// Undo / Redo
// ─────────────────────────────────────────────
const undoStack = [];
const redoStack = [];

function mixerSnapshot() {
  return JSON.parse(JSON.stringify(mixerTracks.map(mt => ({
    id: mt.id, title: mt.title, duration: mt.duration,
    startOffset: mt.startOffset, trimStart: mt.trimStart, trimEnd: mt.trimEnd,
    volume: mt.volume, muted: mt.muted, pan: mt.pan ?? 0,
    color: mt.color, automation: mt.automation ?? [],
  }))));
}

function pushUndo() {
  undoStack.push(mixerSnapshot());
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
}

function applySnapshot(snap) {
  const was = mixerPlaying;
  if (was) stopMixer(false);
  // Remove tracks not in snapshot
  [...mixerTracks].forEach(mt => {
    if (!snap.find(s => s.id === mt.id)) removeMixerTrack(mt);
  });
  // Update or add
  snap.forEach(s => {
    let mt = mixerTracks.find(m => m.id === s.id);
    if (!mt) {
      const tr = tracks.find(t => t.id === s.id);
      if (!tr) return;
      addToMixer(tr);
      mt = mixerTracks[mixerTracks.length - 1];
    }
    Object.assign(mt, {
      startOffset: s.startOffset, trimStart: s.trimStart, trimEnd: s.trimEnd,
      volume: s.volume, muted: s.muted, pan: s.pan, color: s.color,
      automation: s.automation,
    });
    updateBlockGeometry(mt);
    // Sync label controls
    const labelEl = document.querySelector(`.tl-label[data-id="${mt.id}"]`);
    if (labelEl) {
      const vs = labelEl.querySelector('.vol-slider');
      const ps = labelEl.querySelector('.pan-slider');
      const mb = labelEl.querySelector('.mute-btn');
      if (vs) vs.value = mt.volume;
      if (ps) ps.value = mt.pan;
      if (mb) mb.classList.toggle('muted', mt.muted);
    }
  });
  buildRuler();
  updateMixerTimeDisplay();
  if (was) startMixer();
}

document.getElementById('undo-btn').addEventListener('click', () => {
  if (!undoStack.length) return;
  redoStack.push(mixerSnapshot());
  applySnapshot(undoStack.pop());
});
document.getElementById('redo-btn').addEventListener('click', () => {
  if (!redoStack.length) return;
  undoStack.push(mixerSnapshot());
  applySnapshot(redoStack.pop());
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    if (!undoStack.length) return;
    redoStack.push(mixerSnapshot());
    applySnapshot(undoStack.pop());
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    if (!redoStack.length) return;
    undoStack.push(mixerSnapshot());
    applySnapshot(redoStack.pop());
    e.preventDefault();
  }
});

// ─────────────────────────────────────────────
// Volume Automation (Alt+click on block)
// ─────────────────────────────────────────────
function renderAutomation(mt) {
  const block = mt.blockEl;
  if (!block) return;
  let canvas = block.querySelector('.auto-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'auto-canvas';
    block.appendChild(canvas);
    canvas.addEventListener('click', e => {
      if (!e.altKey) return;
      e.stopPropagation();
      pushUndo();
      const rect = canvas.getBoundingClientRect();
      const t = ((e.clientX - rect.left) / rect.width) * (mt.trimEnd - mt.trimStart);
      const v = 1 - (e.clientY - rect.top) / rect.height;
      mt.automation.push({t: Math.max(0, t), v: Math.max(0, Math.min(1, v))});
      mt.automation.sort((a, b) => a.t - b.t);
      renderAutomation(mt);
      scheduleSave();
    });
    canvas.addEventListener('contextmenu', e => {
      if (!mt.automation.length) return;
      e.preventDefault(); e.stopPropagation();
      pushUndo();
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const dur = mt.trimEnd - mt.trimStart;
      let closest = 0, minD = Infinity;
      mt.automation.forEach((pt, i) => {
        const d = Math.abs(pt.t / dur - mx);
        if (d < minD) { minD = d; closest = i; }
      });
      mt.automation.splice(closest, 1);
      renderAutomation(mt);
      scheduleSave();
    });
  }
  canvas.width  = block.offsetWidth  || 120;
  canvas.height = block.offsetHeight || 28;
  const W = canvas.width, H = canvas.height;
  const ctx2 = canvas.getContext('2d');
  ctx2.clearRect(0, 0, W, H);
  if (!mt.automation.length) return;
  const dur = mt.trimEnd - mt.trimStart;
  ctx2.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx2.lineWidth = 1.5;
  ctx2.beginPath();
  mt.automation.forEach((pt, i) => {
    const x = (pt.t / dur) * W, y = (1 - pt.v) * H;
    i === 0 ? ctx2.moveTo(x, y) : ctx2.lineTo(x, y);
  });
  ctx2.stroke();
  ctx2.fillStyle = '#fff';
  mt.automation.forEach(pt => {
    const x = (pt.t / dur) * W, y = (1 - pt.v) * H;
    ctx2.beginPath(); ctx2.arc(x, y, 3, 0, 6.28); ctx2.fill();
  });
}

// Automation is rendered lazily when tab is opened
document.querySelector('[data-tab="mixer"]').addEventListener('click', () => {
  setTimeout(() => mixerTracks.forEach(mt => renderAutomation(mt)), 50);
});

// ─────────────────────────────────────────────
// Web MIDI API
// ─────────────────────────────────────────────
const midiIndicator = document.getElementById('midi-indicator');

async function setupMidi() {
  if (!navigator.requestMIDIAccess) { return; }
  try {
    const midi = await navigator.requestMIDIAccess();
    const connect = port => { port.onmidimessage = handleMidi; };
    midi.inputs.forEach(connect);
    const count = midi.inputs.size;
    if (count > 0) { midiIndicator.textContent = `MIDI ● (${count})`; midiIndicator.classList.add('active'); }
    else midiIndicator.textContent = 'MIDI ○';
    midi.onstatechange = e => {
      if (e.port.type === 'input' && e.port.state === 'connected') connect(e.port);
      midiIndicator.textContent = `MIDI ● (${midi.inputs.size})`;
      midiIndicator.classList.toggle('active', midi.inputs.size > 0);
    };
  } catch {}
}

function handleMidi(msg) {
  const [status, note, vel] = msg.data;
  const cmd = status & 0xF0;
  if (cmd === 0x90 && vel > 0) {           // Note On
    if (note >= 36 && note <= 44) triggerPad(note - 36);        // C2-A2 → 패드 0-8
    if (note === 48) decks[0].isPlaying ? pauseDeck(decks[0]) : playDeck(decks[0]);
    if (note === 49) decks[1].isPlaying ? pauseDeck(decks[1]) : playDeck(decks[1]);
  } else if (cmd === 0xB0) {                // Control Change
    if (note === 7  && masterVolNode) masterVolNode.gain.value = (vel / 127) * 1.2;   // CC7 master vol
    if (note === 1)  { const d = decks[0]; const r = 0.5 + (vel/127)*1.5; d.baseRate=r; if(d.isPlaying){snapshotDeckPos(d);d.targetRate=r;startDeckSource(d);} }
    if (note === 2)  { const d = decks[1]; const r = 0.5 + (vel/127)*1.5; d.baseRate=r; if(d.isPlaying){snapshotDeckPos(d);d.targetRate=r;startDeckSource(d);} }
    if (note === 10) { const v = vel/127; if(decks[0].crossNode) decks[0].crossNode.gain.value=Math.cos(v*Math.PI/2); if(decks[1].crossNode) decks[1].crossNode.gain.value=Math.sin(v*Math.PI/2); }
  }
}

setupMidi();

// ─────────────────────────────────────────────
// Sampler per-pad settings
// ─────────────────────────────────────────────
let padSettingsIdx = -1;
const padOverlay = document.getElementById('pad-settings-overlay');
const padVolSlider = document.getElementById('pad-vol');
const padVolVal   = document.getElementById('pad-vol-val');
const padPitchSlider = document.getElementById('pad-pitch');
const padPitchVal = document.getElementById('pad-pitch-val');

function openPadSettings(idx) {
  const pad = pads[idx];
  if (!pad) return;
  padSettingsIdx = idx;
  document.getElementById('pad-settings-title').textContent = `패드 ${idx+1}: ${pad.title}`;
  padVolSlider.value = pad.padVolume ?? 1;
  padVolVal.textContent = Math.round((pad.padVolume ?? 1) * 100) + '%';
  padPitchSlider.value = pad.padPitch ?? 0;
  padPitchVal.textContent = (pad.padPitch ?? 0) + ' st';
  document.querySelectorAll('.pad-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === (pad.padMode || 'oneshot')));
  padOverlay.style.display = 'flex';
}

padVolSlider.addEventListener('input', () => {
  const pad = pads[padSettingsIdx]; if (!pad) return;
  pad.padVolume = +padVolSlider.value;
  padVolVal.textContent = Math.round(pad.padVolume * 100) + '%';
  scheduleSave();
});
padPitchSlider.addEventListener('input', () => {
  const pad = pads[padSettingsIdx]; if (!pad) return;
  pad.padPitch = +padPitchSlider.value;
  padPitchVal.textContent = pad.padPitch + ' st';
  scheduleSave();
});
document.querySelectorAll('.pad-mode-btn').forEach(b => {
  b.addEventListener('click', () => {
    const pad = pads[padSettingsIdx]; if (!pad) return;
    pad.padMode = b.dataset.mode;
    document.querySelectorAll('.pad-mode-btn').forEach(x => x.classList.toggle('active', x === b));
    scheduleSave();
  });
});
document.getElementById('pad-settings-close').addEventListener('click', () => { padOverlay.style.display = 'none'; });
padOverlay.addEventListener('click', e => { if (e.target === padOverlay) padOverlay.style.display = 'none'; });
