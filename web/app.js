import createMoonsoundModule from './player/moonsound.js';

const query = new URLSearchParams(window.location.search);
const RUNTIME_FLAGS = {
  romTest: query.has('rom-test'),
  clearRomCache: query.has('clear-rom-cache'),
  disableBundledRom: query.has('disable-bundled-rom')
};

if (RUNTIME_FLAGS.romTest) {
  RUNTIME_FLAGS.clearRomCache = true;
  RUNTIME_FLAGS.disableBundledRom = true;
}

const state = {
  catalog: null,
  currentDiskIndex: 0,
  selectedTrackKey: '',
  romOverlayVisible: false,
  autoAdvanceAfterEnd: false,
  playbackTimerId: null,
  playbackStartedAtMs: 0,
  playbackTotalSeconds: NaN
};

const els = {
  diskMenu: document.querySelector('#disk-menu'),
  diskTitle: document.querySelector('#disk-title'),
  diskCount: document.querySelector('#disk-count'),
  trackList: document.querySelector('#track-list'),
  nowMeta: document.querySelector('#now-meta'),
  statePill: document.querySelector('#state-pill'),
  status: document.querySelector('#status'),
  playBtn: document.querySelector('#play-btn'),
  stopBtn: document.querySelector('#stop-btn'),
  loopCount: document.querySelector('#loop-count'),
  romOverlay: document.querySelector('#rom-overlay'),
  playbackTime: document.querySelector('#playback-time')
};

const DISK_THEME = {
  DMV1: {
    selectBg: '#c71906',
    selectFg: '#ff7e64',
    sunA: '#ffe761',
    sunB: '#ffb300',
    sunC: '#ff5f00',
    skyA: '#320000',
    skyB: '#8b1c00',
    skyC: '#0f0000'
  },
  DMV2: {
    selectBg: '#0b0ea0',
    selectFg: '#2f7cff',
    sunA: '#d0ffff',
    sunB: '#60e4ff',
    sunC: '#2197ff',
    skyA: '#020a3b',
    skyB: '#061a74',
    skyC: '#000c3a'
  },
  DMV3: {
    selectBg: '#0c6e13',
    selectFg: '#79ff82',
    sunA: '#e8ff8a',
    sunB: '#79da49',
    sunC: '#33a53a',
    skyA: '#052204',
    skyB: '#1f5b11',
    skyC: '#0a2f08'
  },
  DMVFT: {
    selectBg: '#4f0aa5',
    selectFg: '#c892ff',
    sunA: '#ffd3ff',
    sunB: '#d26eff',
    sunC: '#8b2eff',
    skyA: '#1a0737',
    skyB: '#3e1476',
    skyC: '#1a0838'
  }
};

function trackKey(track) {
  return `${track.diskFolder}:${track.mwm}:${track.mwk}`;
}

function syncFs(module, populate) {
  return new Promise((resolve, reject) => {
    module.FS.syncfs(populate, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class MoonSoundPlayer {
  constructor() {
    this.module = null;
    this.ctx = null;
    this.workletNode = null;
    this.gainNode = null;
    this.bufferPtr = 0;
    this.framesPerChunk = 2048;
    this.coreReady = false;
    this.moduleReady = false;
    this.idbfsMounted = false;
    this.idbfsEnabled = false;
    this.isPlaying = false;
    this.pumpTimer = null;

    this.fn = {};
    this.onEnded = null;
    this.lastTotalSamples = 0;
  }

  async initModule() {
    if (this.moduleReady) return;

    this.module = await createMoonsoundModule({
      locateFile: (file) => `./player/${file}`
    });

    this.fn.loadCore = this.module.cwrap('dmv_load_core', 'number', ['string', 'string']);
    this.fn.prepareSong = this.module.cwrap('dmv_prepare_song', 'number', ['string', 'string', 'number']);
    this.fn.render = this.module.cwrap('dmv_render_pcm', 'number', ['number', 'number']);
    this.fn.stopSong = this.module.cwrap('dmv_stop_song', null, []);
    this.fn.shutdown = this.module.cwrap('dmv_shutdown', null, []);
    this.fn.lastError = this.module.cwrap('dmv_last_error', 'string', []);
    this.fn.sampleRate = this.module.cwrap('dmv_sample_rate', 'number', []);
    this.fn.totalSamples = this.module.cwrap('dmv_total_samples', 'number', []);

    this.bufferPtr = this.module._malloc(this.framesPerChunk * 2 * 2);
    this.moduleReady = true;
    await this.mountPersistentFs();
  }

  async mountPersistentFs() {
    if (!this.module || this.idbfsMounted) return;
    this.module.FS.mkdirTree('/persist');
    const idbfs = this.module.FS?.filesystems?.IDBFS;
    if (!idbfs) {
      this.idbfsMounted = true;
      this.idbfsEnabled = false;
      return;
    }
    this.module.FS.mount(idbfs, {}, '/persist');
    await syncFs(this.module, true);
    this.idbfsMounted = true;
    this.idbfsEnabled = true;
  }

  hasPersistedRom() {
    if (!this.moduleReady) return false;
    return this.module.FS.analyzePath('/persist/yrw801.rom').exists;
  }

  async clearPersistedRom() {
    if (!this.moduleReady) return;
    if (!this.hasPersistedRom()) return;
    this.module.FS.unlink('/persist/yrw801.rom');
    if (this.idbfsEnabled) {
      await syncFs(this.module, false);
    }
  }

  async storeRom(romBytes) {
    if (!this.moduleReady) throw new Error('Module is not ready.');
    this.module.FS.writeFile('/persist/yrw801.rom', romBytes);
    if (this.idbfsEnabled) {
      await syncFs(this.module, false);
    }
  }

  async ensureCoreReady() {
    if (this.coreReady) return;
    await this.initModule();
    if (RUNTIME_FLAGS.clearRomCache) {
      await this.clearPersistedRom();
      RUNTIME_FLAGS.clearRomCache = false;
    }
    await this.loadCoreAssets();
  }

  async loadCoreAssets() {
    let rom;
    if (this.hasPersistedRom()) {
      rom = this.module.FS.readFile('/persist/yrw801.rom');
    } else {
      if (RUNTIME_FLAGS.disableBundledRom) {
        const romError = new Error('Missing yrw801.rom.');
        romError.code = 'ROM_REQUIRED';
        throw romError;
      }
      try {
        rom = await fetchAsU8('./assets/yrw801.rom');
      } catch {
        const romError = new Error('Missing yrw801.rom.');
        romError.code = 'ROM_REQUIRED';
        throw romError;
      }
    }

    const waves = await fetchAsU8('./assets/waves.dat');

    this.module.FS.mkdirTree('/core');
    this.module.FS.writeFile('/core/yrw801.rom', rom);
    this.module.FS.writeFile('/core/waves.dat', waves);

    const ok = this.fn.loadCore('/core/yrw801.rom', '/core/waves.dat');
    if (!ok) throw new Error(this.fn.lastError() || 'Failed to load core assets.');

    this.coreReady = true;
  }

  async ensureAudioContext() {
    if (!this.ctx) {
      this.ctx = new window.AudioContext({ sampleRate: this.fn.sampleRate() });
    }

    if (this.ctx.state !== 'running') {
      await this.ctx.resume();
    }

    if (this.ctx.state !== 'running') {
      throw new Error(`Audio context is ${this.ctx.state}. Click Play again.`);
    }
  }

  async ensureAudioGraph() {
    await this.ensureAudioContext();

    if (!this.workletNode) {
      setStatus('Loading AudioWorklet module...');
      await this.ctx.audioWorklet.addModule('./player/moonsound-audio-processor.js');
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 1;
      this.gainNode.connect(this.ctx.destination);
      this.workletNode = new AudioWorkletNode(this.ctx, 'moonsound-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      this.workletNode.connect(this.gainNode);
      this.workletNode.onprocessorerror = () => {
        setStatus('AudioWorklet processor error.');
      };
      this.workletNode.port.onmessage = (event) => {
        if (event.data?.type === 'need-data') {
          this.pumpBuffers();
        } else if (event.data?.type === 'drained') {
          if (this.onEnded) this.onEnded();
        }
      };
      this.workletNode.port.postMessage({ type: 'ping' });
    }
  }

  async play(track, loops) {
    if (!this.coreReady) throw new Error('Player is not ready.');

    await this.ensureAudioGraph();

    if (this.isPlaying) {
      this.stop();
    }

    const { mwmPath, mwkPath } = await this.stageTrackFiles(track);
    const ok = this.fn.prepareSong(mwmPath, mwkPath || '', loops);
    if (!ok) throw new Error(this.fn.lastError() || 'Failed to prepare song.');
    this.lastTotalSamples = this.fn.totalSamples();

    if (this.gainNode) {
      const now = this.ctx.currentTime;
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(1, now);
    }

    this.isPlaying = true;
    this.workletNode.port.postMessage({ type: 'stop' });
    this.pumpBuffers();
    this.workletNode.port.postMessage({ type: 'start' });
    this.startPumpTimer();
  }

  pumpBuffers() {
    if (!this.isPlaying || !this.workletNode || !this.module) return;

    for (let chunk = 0; chunk < 4; chunk += 1) {
      const rendered = this.fn.render(this.bufferPtr, this.framesPerChunk);
      if (rendered <= 0) {
        this.isPlaying = false;
        this.stopPumpTimer();
        this.workletNode.port.postMessage({ type: 'end' });
        return;
      }

      const heap = this.module.HEAP16;
      if (!heap) {
        this.isPlaying = false;
        this.stopPumpTimer();
        this.workletNode.port.postMessage({ type: 'end' });
        if (this.onEnded) this.onEnded(new Error('WASM heap view unavailable.'));
        return;
      }

      const start = this.bufferPtr >> 1;
      const left = new Float32Array(rendered);
      const right = new Float32Array(rendered);

      for (let i = 0; i < rendered; i += 1) {
        left[i] = heap[start + i * 2] / 32768;
        right[i] = heap[start + i * 2 + 1] / 32768;
      }

      this.workletNode.port.postMessage({ type: 'buffer', left, right }, [left.buffer, right.buffer]);

      if (rendered < this.framesPerChunk) {
        this.isPlaying = false;
        this.stopPumpTimer();
        this.workletNode.port.postMessage({ type: 'end' });
        return;
      }
    }
  }

  startPumpTimer() {
    this.stopPumpTimer();
    this.pumpTimer = window.setInterval(() => this.pumpBuffers(), 30);
  }

  stopPumpTimer() {
    if (this.pumpTimer !== null) {
      window.clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  stop() {
    if (!this.module) return;

    this.isPlaying = false;
    this.stopPumpTimer();
    if (this.workletNode) this.workletNode.port.postMessage({ type: 'stop' });
    this.fn.stopSong();
  }

  async fadeOut(durationMs = 1000) {
    if (!this.ctx || !this.gainNode) return;
    const now = this.ctx.currentTime;
    const end = now + durationMs / 1000;
    const current = this.gainNode.gain.value;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(current, now);
    this.gainNode.gain.linearRampToValueAtTime(0, end);
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
  }

  shutdown() {
    this.stop();
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    if (this.module) this.fn.shutdown();
  }

  async stageTrackFiles(track) {
    this.module.FS.mkdirTree('/music');

    const mwmResolved = await fetchFirstExisting(track.diskFolder, buildFileCandidates(track.mwm));
    this.module.FS.writeFile('/music/song.mwm', mwmResolved.bytes);

    let mwkResolved = null;
    if (track.mwk !== '*') {
      mwkResolved = await fetchFirstExisting(track.diskFolder, buildFileCandidates(track.mwk));
      this.module.FS.writeFile('/music/song.mwk', mwkResolved.bytes);
    }

    return { mwmPath: '/music/song.mwm', mwkPath: mwkResolved ? '/music/song.mwk' : '' };
  }
}

const player = new MoonSoundPlayer();
player.onEnded = async (error) => {
  setPlayingState(false);
  stopPlaybackTimer();
  if (Number.isFinite(state.playbackTotalSeconds)) {
    updatePlaybackTimeDisplay(state.playbackTotalSeconds, state.playbackTotalSeconds);
  }
  if (error) {
    setStatus(`Playback ended with error: ${error.message}`);
    return;
  }

  if (!state.autoAdvanceAfterEnd) {
    setStatus('Playback finished.');
    return;
  }

  const next = nextTrack(activeTrack());
  if (!next) {
    setStatus('Playback finished.');
    return;
  }

  try {
    setStatus(`Loading ${next.title}...`);
    player.stop();
    setSelectedTrack(next);
    renderTracks();
    updateNowPlayingMeta();
    await handlePlay();
  } catch (advanceError) {
    setStatus(`Auto-next failed: ${advanceError.message}`);
  }
};

function setStatus(message) {
  els.status.textContent = message;
}

function setPlayingState(isPlaying) {
  els.statePill.textContent = isPlaying ? 'Playing' : 'Idle';
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function updatePlaybackTimeDisplay(currentSec, totalSec) {
  if (!els.playbackTime) return;
  els.playbackTime.textContent = `${formatClock(currentSec)}/${formatClock(totalSec)}`;
}

function stopPlaybackTimer() {
  if (state.playbackTimerId !== null) {
    window.clearInterval(state.playbackTimerId);
    state.playbackTimerId = null;
  }
}

function startPlaybackTimer(totalSeconds) {
  stopPlaybackTimer();
  state.playbackStartedAtMs = performance.now();
  state.playbackTotalSeconds = totalSeconds;
  updatePlaybackTimeDisplay(0, totalSeconds);
  state.playbackTimerId = window.setInterval(() => {
    const elapsed = (performance.now() - state.playbackStartedAtMs) / 1000;
    updatePlaybackTimeDisplay(Math.min(elapsed, totalSeconds), totalSeconds);
  }, 200);
}

function setControlsEnabled(enabled) {
  els.playBtn.disabled = !enabled;
  els.stopBtn.disabled = !enabled;
  els.loopCount.disabled = !enabled;
}

function setRomOverlay(visible) {
  state.romOverlayVisible = visible;
  if (!els.romOverlay) return;
  els.romOverlay.classList.toggle('hidden', !visible);
}

function activeDisk() {
  return state.catalog.disks[state.currentDiskIndex];
}

function applyDiskTheme(diskId) {
  const t = DISK_THEME[diskId] || DISK_THEME.DMV1;
  const root = document.documentElement.style;
  root.setProperty('--select-bg', t.selectBg);
  root.setProperty('--select-fg', t.selectFg);
  root.setProperty('--sun-a', t.sunA);
  root.setProperty('--sun-b', t.sunB);
  root.setProperty('--sun-c', t.sunC);
  root.setProperty('--sky-a', t.skyA);
  root.setProperty('--sky-b', t.skyB);
  root.setProperty('--sky-c', t.skyC);
}

function displayTracksForDisk(disk) {
  // Keep original DISKEXEC order to match the real MSX menu.
  return [...disk.tracks];
}

function interleaveColumns(tracks) {
  // MSX menu is stored/displayed as: left column first half, right column second half.
  // CSS grid renders row-wise, so interleave to preserve the original visual ordering.
  const half = Math.ceil(tracks.length / 2);
  const left = tracks.slice(0, half);
  const right = tracks.slice(half);
  const out = [];
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i += 1) {
    if (left[i]) out.push(left[i]);
    if (right[i]) out.push(right[i]);
  }
  return out;
}

function activeTrack() {
  const tracks = displayTracksForDisk(activeDisk());
  if (!tracks.length) return null;
  const found = tracks.find((t) => trackKey(t) === state.selectedTrackKey);
  return found || tracks[0];
}

function setSelectedTrack(track) {
  if (!track) return;
  state.selectedTrackKey = trackKey(track);
}

function nextTrack(current) {
  const tracks = displayTracksForDisk(activeDisk());
  if (!tracks.length) return null;
  if (!current) return tracks[0];
  const idx = tracks.findIndex((t) => trackKey(t) === trackKey(current));
  if (idx < 0) return tracks[0];
  const nextIdx = (idx + 1) % tracks.length;
  return tracks[nextIdx];
}

function renderDiskMenu() {
  els.diskMenu.innerHTML = '';
  state.catalog.disks.forEach((disk, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `disk-btn${idx === state.currentDiskIndex ? ' active' : ''}`;
    btn.textContent = disk.id;
    btn.addEventListener('click', () => {
      state.currentDiskIndex = idx;
      setSelectedTrack(displayTracksForDisk(activeDisk())[0] || null);
      applyDiskTheme(activeDisk().id);
      renderDiskMenu();
      renderTracks();
      updateNowPlayingMeta();
    });
    els.diskMenu.appendChild(btn);
  });
}

function renderTracks() {
  const disk = activeDisk();
  const tracks = displayTracksForDisk(disk);
  const tracksForGrid = interleaveColumns(tracks);
  els.diskTitle.textContent = `Disc ${disk.id.replace('DMV', '')}`;
  els.diskCount.textContent = `${tracks.length} tracks`;

  if (!state.selectedTrackKey && tracks[0]) {
    setSelectedTrack(tracks[0]);
  }

  els.trackList.innerHTML = '';
  for (const track of tracksForGrid) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `track${trackKey(track) === state.selectedTrackKey ? ' active' : ''}`;
    item.textContent = track.title;
    if (!track.available) {
      item.classList.add('unavailable');
      item.disabled = true;
    }

    item.addEventListener('click', () => {
      setSelectedTrack(track);
      renderTracks();
      updateNowPlayingMeta();
    });

    item.addEventListener('dblclick', () => {
      setSelectedTrack(track);
      renderTracks();
      updateNowPlayingMeta();
      handlePlay();
    });

    els.trackList.appendChild(item);
  }
}

function updateNowPlayingMeta() {
  const track = activeTrack();
  if (!track) {
    els.nowMeta.textContent = 'Now playing none';
    return;
  }
  els.nowMeta.textContent = `Now playing ${track.title} by ${track.author}`;
}

async function loadCatalog() {
  const response = await fetch('./catalog.json');
  if (!response.ok) throw new Error(`Failed to load catalog.json (${response.status})`);
  const catalog = await response.json();
  state.catalog = catalog;
  for (const disk of state.catalog.disks) {
    for (const track of disk.tracks) {
      track.diskFolder = disk.folder;
    }
  }
}

function buildFileCandidates(filename) {
  const normalized = filename.toUpperCase();
  const [base = '', ext = ''] = normalized.split('.');
  const shortName = `${base.slice(0, 8)}${ext ? `.${ext.slice(0, 3)}` : ''}`;
  const out = [normalized];
  if (shortName !== normalized) out.push(shortName);
  return [...new Set(out)];
}

async function fetchFirstExisting(folder, candidateNames) {
  const inWebSubdir = window.location.pathname.includes('/web/');
  const pathPrefixes = inWebSubdir ? ['../', '', './'] : ['', './', '../'];
  const errors = [];

  for (const prefix of pathPrefixes) {
    for (const name of candidateNames) {
      const relPath = `${prefix}${folder}/${name}`;
      try {
        return { name, bytes: await fetchAsU8(relPath) };
      } catch (error) {
        errors.push(`${relPath}: ${error.message}`);
      }
    }
  }

  throw new Error(`Unable to load file in ${folder}. Tried: ${errors.join(' | ')}`);
}

async function fetchAsU8(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function tryInitializeCore() {
  try {
    await player.ensureCoreReady();
    setRomOverlay(false);
    setControlsEnabled(true);
    setStatus('Ready. Double-click a title to play.');
    return true;
  } catch (error) {
    if (error?.code === 'ROM_REQUIRED') {
      setControlsEnabled(false);
      setRomOverlay(true);
      setStatus('Drop yrw801.rom to continue.');
      return false;
    }
    throw error;
  }
}

function findDroppedRomFile(dataTransfer) {
  const files = [...(dataTransfer?.files || [])];
  return files.find((file) => file.name.toLowerCase() === 'yrw801.rom') || null;
}

async function handleRomDrop(file) {
  setStatus('Importing yrw801.rom...');
  const romBytes = new Uint8Array(await file.arrayBuffer());
  await player.storeRom(romBytes);
  setStatus('ROM imported. Initializing playback core...');
  await tryInitializeCore();
}

async function handlePlay() {
  if (!player.coreReady) {
    setStatus('Drop yrw801.rom to enable playback.');
    setRomOverlay(true);
    return;
  }

  const track = activeTrack();
  if (!track) return;
  if (!track.available) {
    setStatus('This menu entry exists, but the referenced file is missing.');
    return;
  }

  const loops = Number.parseInt(els.loopCount.value, 10);
  const loopCount = Number.isFinite(loops) ? Math.max(0, Math.min(99, loops)) : 0;
  state.autoAdvanceAfterEnd = loopCount > 0;
  // 0 keeps practical infinite mode, finite values map to intro + (N + 1) loops.
  const effectiveLoops = loopCount === 0 ? 99 : loopCount + 1;

  setStatus(`Loading ${track.title}...`);

  try {
    await player.play(track, effectiveLoops);
    const totalSeconds = player.lastTotalSamples > 0
      ? player.lastTotalSamples / player.fn.sampleRate()
      : NaN;
    if (Number.isFinite(totalSeconds)) {
      startPlaybackTimer(totalSeconds);
    } else {
      stopPlaybackTimer();
      updatePlaybackTimeDisplay(0, NaN);
    }
    setPlayingState(true);
    els.nowMeta.textContent = `Now playing ${track.title} by ${track.author}`;
    setStatus(`Playing ${track.title} (${activeDisk().id})${loopCount === 0 ? ' - infinite mode' : ''}`);
  } catch (error) {
    setPlayingState(false);
    setStatus(`Play error: ${error.message}`);
  }
}

function handleStop() {
  state.autoAdvanceAfterEnd = false;
  player.stop();
  setPlayingState(false);
  stopPlaybackTimer();
  if (Number.isFinite(state.playbackTotalSeconds)) {
    updatePlaybackTimeDisplay(0, state.playbackTotalSeconds);
  } else {
    updatePlaybackTimeDisplay(0, NaN);
  }
  setStatus('Stopped.');
}

async function boot() {
  try {
    setStatus('Loading menu catalog...');
    await loadCatalog();

    setSelectedTrack(displayTracksForDisk(activeDisk())[0] || null);
    applyDiskTheme(activeDisk().id);

    renderDiskMenu();
    renderTracks();
    updateNowPlayingMeta();

    setControlsEnabled(false);
    state.autoAdvanceAfterEnd = false;
    setPlayingState(false);
    updatePlaybackTimeDisplay(0, NaN);

    setStatus('Initializing libmoonsound WASM...');
    await player.initModule();
    await tryInitializeCore();
  } catch (error) {
    setStatus(`Initialization failed: ${error.message}`);
  }
}

if (els.romOverlay) {
  els.romOverlay.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  els.romOverlay.addEventListener('drop', async (event) => {
    event.preventDefault();
    const romFile = findDroppedRomFile(event.dataTransfer);
    if (!romFile) {
      setStatus('Please drop a file named yrw801.rom.');
      return;
    }
    try {
      await handleRomDrop(romFile);
    } catch (error) {
      setStatus(`ROM import failed: ${error.message}`);
    }
  });
}

els.playBtn.addEventListener('click', handlePlay);
els.stopBtn.addEventListener('click', handleStop);

window.addEventListener('beforeunload', () => {
  try {
    player.shutdown();
  } catch {
    // no-op
  }
});

boot();
