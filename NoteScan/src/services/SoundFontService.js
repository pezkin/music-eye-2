import { Asset } from 'expo-asset';
import { File } from 'expo-file-system/next';

/**
 * SoundFont 2 (.sf2) loader and sample renderer.
 *
 * Parses a SoundFont file to extract instrument samples, then provides
 * a method to render any MIDI note at any duration by pitch-shifting
 * the closest available sample.
 *
 * This replaces the simple sine-wave synthesis in AudioPlaybackService
 * with real instrument samples for significantly better audio quality.
 */
class SoundFontServiceClass {
  _loaded = false;
  _loading = false;

  /** Raw 16-bit PCM sample pool (Int16Array) */
  _sampleData = null;

  /** Parsed sample headers from the 'shdr' sub-chunk */
  _sampleHeaders = [];

  /**
   * ALL instrument zones (from every instrument in the SF2).
   * Each zone also carries an `instrumentIndex` so we can filter by preset.
   */
  _allZones = [];

  /**
   * Active zones — filtered to the currently selected preset's instruments.
   * This is the array used by _findZone / renderNote.
   */
  _zones = [];

  /** Quick lookup: MIDI note → best zone (rebuilt when preset changes) */
  _noteToZone = new Map();

  /** Parsed preset list: [{ name, preset, bank, instrumentIndices }] */
  _presets = [];

  /** Index into _presets for the currently active preset (default 0 = Grand Piano) */
  _activePresetIndex = 0;

  get isLoaded() {
    return this._loaded;
  }

  /* ────────────────────────────────────────────
   *  Public API
   * ──────────────────────────────────────────── */

  /**
   * Load and parse the SoundFont file.
   * @param {number} assetModule - result of require('./SheetMusicScanner.sf2')
   */
  async loadSoundFont(assetModule) {
    if (this._loaded || this._loading) return;
    this._loading = true;

    try {
      console.log('🎵 Loading SoundFont...');

      // Download the asset to a local file
      const [asset] = await Asset.loadAsync(assetModule);
      const localUri = asset.localUri || asset.uri;

      // Read raw bytes using the new File API
      const file = new File(localUri);
      const raw = await file.arrayBuffer();

      console.log(`🎵 SF2 file loaded: ${(raw.byteLength / 1024 / 1024).toFixed(1)} MB`);

      // Parse the RIFF/SF2 structure
      this._parse(raw);

      // Build fast MIDI-note lookup
      this._buildNoteMap();

      // Default to the first preset (typically Grand Piano / Acoustic Grand)
      this._selectPresetByIndex(0);

      this._loaded = true;
      console.log(
        `✅ SoundFont ready: ${this._sampleHeaders.length} samples, ` +
        `${this._allZones.length} total zones, ${this._presets.length} presets, ` +
        `active preset: "${this._presets[0]?.name || 'none'}"`
      );
    } catch (err) {
      console.error('❌ SoundFont load error:', err);
      // Non-fatal — the app falls back to synthesis
    } finally {
      this._loading = false;
    }
  }

  /* ────────────────────────────────────────────
   *  Preset / instrument selection
   * ──────────────────────────────────────────── */

  /**
   * Return the list of available presets (instruments) from the SoundFont.
   * Each entry: { index, name, preset, bank }
   */
  getAvailablePresets() {
    return this._presets.map((p, i) => ({
      index: i,
      name: p.name,
      preset: p.preset,
      bank: p.bank,
    }));
  }

  /** Currently selected preset index */
  getActivePresetIndex() {
    return this._activePresetIndex;
  }

  /**
   * Select a preset by its index in the _presets array.
   * Rebuilds the active zone list and note map.
   */
  selectPreset(index) {
    if (!this._loaded) return;
    this._selectPresetByIndex(index);
  }

  /** Internal: filter zones to the given preset and rebuild the note map. */
  _selectPresetByIndex(index) {
    if (index < 0 || index >= this._presets.length) {
      // Fallback: use ALL zones (legacy behaviour)
      this._zones = this._allZones;
      this._activePresetIndex = 0;
    } else {
      const preset = this._presets[index];
      const allowedInstruments = new Set(preset.instrumentIndices);
      this._zones = this._allZones.filter(z => allowedInstruments.has(z.instrumentIndex));
      this._activePresetIndex = index;

      // If filtering left us with nothing, fall back to all zones
      if (this._zones.length === 0) {
        console.warn(`⚠️ Preset "${preset.name}" yielded 0 zones — falling back to all zones`);
        this._zones = this._allZones;
      } else {
        console.log(`🎵 Selected preset "${preset.name}": ${this._zones.length} zones`);
      }
    }
    this._buildNoteMap();
  }

  /**
   * Render a note from SoundFont samples.
   * Returns a Float32Array of mono 44100 Hz audio, or null if SF2 isn't loaded.
   *
   * @param {number} midiNote  0-127
   * @param {number} duration  seconds
   * @param {number} velocity  0-127
   * @returns {Float32Array|null}
   */
  renderNote(midiNote, duration = 1.0, velocity = 100) {
    if (!this._loaded || this._zones.length === 0) return null;

    const zone = this._findZone(midiNote, velocity);
    if (!zone) return null;

    const outputRate = 44100;
    const sampleCount = Math.floor(outputRate * duration);
    const output = new Float32Array(sampleCount);

    // Calculate pitch ratio: shift the sample to match the target note
    const semitones = midiNote - zone.rootKey + (zone.tuning || 0) / 100;
    const pitchRatio = Math.pow(2, semitones / 12) * (zone.sampleRate / outputRate);

    // Sample boundaries in the pool
    const smpStart = zone.startOffset;
    const smpEnd = zone.endOffset;
    const loopStart = zone.startLoop;
    const loopEnd = zone.endLoop;
    const MIN_LOOP_LEN = 32; // minimum samples for a usable loop
    // Only loop if sampleMode says so (1 = continuous, 3 = loop-then-release)
    // and the loop region is large enough to avoid buzzing
    const loopEnabled = (zone.loopMode === 1 || zone.loopMode === 3);
    const hasLoop = loopEnabled &&
                    (loopEnd - loopStart) >= MIN_LOOP_LEN &&
                    loopStart >= smpStart && loopEnd <= smpEnd;

    const velocityFactor = velocity / 127;

    // ADSR envelope from SF2 zone (with sensible minimums to prevent clicks)
    const attackTime = Math.max(0.003, Math.min(zone.volAttack || 0.005, 2.0));
    const decayTime = Math.max(0.01, Math.min(zone.volDecay || 0.1, 4.0));
    const sustainLevel = Number.isFinite(zone.volSustain) ? zone.volSustain : 0.8;
    // Release fade — always applied at end of note to prevent clicks
    const releaseTime = Math.max(0.015, Math.min(zone.volRelease || 0.15, duration * 0.35, 2.0));

    // Scale attack+decay to fit within available space (leave room for release)
    const availableForADS = Math.max(0, duration - releaseTime);
    const rawADTime = attackTime + decayTime;
    const adsScale = rawADTime > availableForADS && rawADTime > 0
      ? availableForADS / rawADTime : 1.0;
    const actualAttackSamples = Math.floor(outputRate * attackTime * adsScale);
    const actualDecaySamples = Math.floor(outputRate * decayTime * adsScale);

    const releaseSamples = Math.floor(outputRate * releaseTime);
    const releaseStart = Math.max(0, sampleCount - releaseSamples);

    let samplePos = 0; // fractional position in the source sample

    const loopLen = hasLoop ? (loopEnd - loopStart) : 0;

    for (let i = 0; i < sampleCount; i++) {
      // ── Compute read position with efficient loop wrapping ──
      let readPos = samplePos + smpStart;  // absolute position in sample pool

      if (hasLoop && readPos >= loopStart) {
        // O(1) modulo wrap instead of O(n) while loop
        readPos = loopStart + ((readPos - loopStart) % loopLen);
      } else if (!hasLoop && readPos >= smpEnd) {
        // Past end of sample, fill silence
        break;
      }

      const intPos = Math.floor(readPos);
      const frac = readPos - intPos;

      // Linear interpolation — at loop boundary, wrap to loopStart
      const s0 = this._getSample16(intPos);
      const nextPos = (hasLoop && intPos + 1 >= loopEnd) ? loopStart : Math.min(intPos + 1, smpEnd - 1);
      const s1 = this._getSample16(nextPos);
      const sampleValue = (s0 + (s1 - s0) * frac) / 32768; // Normalize to -1..1

      // ── Envelope: ADS shape (attack → decay → sustain) ──
      let adsEnvelope = 1.0;
      if (i < actualAttackSamples) {
        adsEnvelope = i / Math.max(1, actualAttackSamples);
      } else if (i < actualAttackSamples + actualDecaySamples) {
        const p = (i - actualAttackSamples) / Math.max(1, actualDecaySamples);
        adsEnvelope = 1.0 - p * (1.0 - sustainLevel);
      } else {
        adsEnvelope = sustainLevel;
      }

      // ── Release fade: ALWAYS applied at end of note (prevents clicks) ──
      let releaseMul = 1.0;
      if (i >= releaseStart) {
        releaseMul = 1.0 - (i - releaseStart) / Math.max(1, releaseSamples);
      }

      const val = sampleValue * adsEnvelope * releaseMul * velocityFactor * 0.85;
      output[i] = Number.isFinite(val) ? val : 0;
      samplePos += pitchRatio;
    }

    return output;
  }

  /* ────────────────────────────────────────────
   *  SF2 RIFF parser
   * ──────────────────────────────────────────── */

  _parse(buffer) {
    const view = new DataView(buffer);

    // Verify RIFF header
    const riffTag = this._readFourCC(view, 0);
    if (riffTag !== 'RIFF') throw new Error('Not a RIFF file');

    const formType = this._readFourCC(view, 8);
    if (formType !== 'sfbk') throw new Error('Not a SoundFont file');

    // Walk top-level LIST chunks
    let offset = 12;
    const fileEnd = Math.min(view.byteLength, view.getUint32(4, true) + 8);

    while (offset < fileEnd - 8) {
      const chunkId = this._readFourCC(view, offset);
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === 'LIST') {
        const listType = this._readFourCC(view, offset + 8);

        if (listType === 'sdta') {
          this._parseSdta(view, offset + 12, chunkSize - 4);
        } else if (listType === 'pdta') {
          this._parsePdta(view, offset + 12, chunkSize - 4);
        }
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset++; // RIFF padding
    }
  }

  /** Parse sample data chunk */
  _parseSdta(view, start, length) {
    let offset = start;
    const end = start + length;

    while (offset < end - 8) {
      const id = this._readFourCC(view, offset);
      const size = view.getUint32(offset + 4, true);

      if (id === 'smpl') {
        // 16-bit signed PCM sample data
        // Copy to an aligned buffer — the source offset may not be 2-byte aligned,
        // which would produce garbage when viewed as Int16Array.
        const dataStart = offset + 8;
        const aligned = new ArrayBuffer(size);
        new Uint8Array(aligned).set(new Uint8Array(view.buffer, dataStart, size));
        this._sampleData = new Int16Array(aligned);
        console.log(`🎵 Sample pool: ${this._sampleData.length} samples`);
      }

      offset += 8 + size;
      if (size % 2 !== 0) offset++;
    }
  }

  /** Parse preset/instrument/sample header chunks */
  _parsePdta(view, start, length) {
    let offset = start;
    const end = start + length;

    const chunks = {};

    while (offset < end - 8) {
      const id = this._readFourCC(view, offset);
      const size = view.getUint32(offset + 4, true);
      chunks[id] = { offset: offset + 8, size };
      offset += 8 + size;
      if (size % 2 !== 0) offset++;
    }

    // Parse sample headers (46 bytes each)
    if (chunks.shdr) {
      this._parseSampleHeaders(view, chunks.shdr.offset, chunks.shdr.size);
    }

    // Parse instrument zones and generators to build note→sample mapping
    const instruments = chunks.inst ? this._parseInstruments(view, chunks.inst.offset, chunks.inst.size) : [];
    const iBags = chunks.ibag ? this._parseIBag(view, chunks.ibag.offset, chunks.ibag.size) : [];
    const iGens = chunks.igen ? this._parseIGen(view, chunks.igen.offset, chunks.igen.size) : [];

    // Build instrument zones
    this._buildZones(instruments, iBags, iGens);

    // Parse preset headers and their zone→instrument mappings
    const presetHeaders = chunks.phdr ? this._parsePresetHeaders(view, chunks.phdr.offset, chunks.phdr.size) : [];
    const pBags = chunks.pbag ? this._parsePBag(view, chunks.pbag.offset, chunks.pbag.size) : [];
    const pGens = chunks.pgen ? this._parsePGen(view, chunks.pgen.offset, chunks.pgen.size) : [];

    this._buildPresets(presetHeaders, pBags, pGens);
  }

  /** Parse shdr: 46-byte sample header records */
  _parseSampleHeaders(view, offset, size) {
    const count = Math.floor(size / 46);
    this._sampleHeaders = [];

    for (let i = 0; i < count - 1; i++) { // Last entry is EOS terminal
      const o = offset + i * 46;
      const name = this._readFixedString(view, o, 20);
      const start = view.getUint32(o + 20, true);
      const end = view.getUint32(o + 24, true);
      const startLoop = view.getUint32(o + 28, true);
      const endLoop = view.getUint32(o + 32, true);
      const sampleRate = view.getUint32(o + 36, true);
      const originalPitch = view.getUint8(o + 40);
      const pitchCorrection = view.getInt8(o + 41);
      const sampleLink = view.getUint16(o + 42, true);
      const sampleType = view.getUint16(o + 44, true);

      this._sampleHeaders.push({
        name, start, end, startLoop, endLoop,
        sampleRate, originalPitch, pitchCorrection, sampleLink, sampleType,
      });
    }
  }

  /** Parse inst: 22-byte instrument records */
  _parseInstruments(view, offset, size) {
    const count = Math.floor(size / 22);
    const instruments = [];

    for (let i = 0; i < count; i++) {
      const o = offset + i * 22;
      const name = this._readFixedString(view, o, 20);
      const bagIndex = view.getUint16(o + 20, true);
      instruments.push({ name, bagIndex });
    }
    return instruments;
  }

  /** Parse ibag: 4-byte instrument bag records */
  _parseIBag(view, offset, size) {
    const count = Math.floor(size / 4);
    const bags = [];

    for (let i = 0; i < count; i++) {
      const o = offset + i * 4;
      const genIndex = view.getUint16(o, true);
      const modIndex = view.getUint16(o + 2, true);
      bags.push({ genIndex, modIndex });
    }
    return bags;
  }

  /** Parse igen: 4-byte instrument generator records */
  _parseIGen(view, offset, size) {
    const count = Math.floor(size / 4);
    const gens = [];

    for (let i = 0; i < count; i++) {
      const o = offset + i * 4;
      const oper = view.getUint16(o, true);
      const amount = view.getInt16(o + 2, true);
      gens.push({ oper, amount });
    }
    return gens;
  }

  /** Build playable zones from parsed instrument data */
  _buildZones(instruments, iBags, iGens) {
    this._allZones = [];

    // SF2 Generator operator IDs we care about
    const GEN_KEY_RANGE = 43;
    const GEN_VEL_RANGE = 44;
    const GEN_SAMPLE_ID = 53;
    const GEN_OVERRIDING_ROOT_KEY = 58;
    const GEN_FINE_TUNE = 52;
    const GEN_COARSE_TUNE = 51;
    const GEN_START_ADDRS_OFFSET = 0;
    const GEN_END_ADDRS_OFFSET = 1;
    const GEN_STARTLOOP_ADDRS_OFFSET = 2;
    const GEN_ENDLOOP_ADDRS_OFFSET = 3;
    const GEN_START_ADDRS_COARSE_OFFSET = 4;
    const GEN_END_ADDRS_COARSE_OFFSET = 12;
    const GEN_STARTLOOP_ADDRS_COARSE_OFFSET = 45;
    const GEN_ENDLOOP_ADDRS_COARSE_OFFSET = 50;
    const GEN_SAMPLE_MODES = 54;
    // Volume envelope generators (values in timecents / centibels)
    const GEN_VOL_ENV_ATTACK = 34;
    const GEN_VOL_ENV_DECAY = 36;
    const GEN_VOL_ENV_SUSTAIN = 37;  // in centibels attenuation
    const GEN_VOL_ENV_RELEASE = 38;

    /**
     * Parse generators from a range of igen records into a flat object.
     * Returns { keyLo, keyHi, velLo, velHi, sampleIndex, rootKey, ... }
     */
    const parseGens = (genLo, genHi) => {
      const g = {
        keyLo: -1, keyHi: -1,
        velLo: -1, velHi: -1,
        sampleIndex: -1,
        rootKey: -1,
        fineTune: 0, coarseTune: 0,
        startOffset: 0, endOffset: 0,
        startLoopOffset: 0, endLoopOffset: 0,
        startCoarseOffset: 0, endCoarseOffset: 0,
        startLoopCoarseOffset: 0, endLoopCoarseOffset: 0,
        sampleMode: -1,
        volEnvAttack: -32768, volEnvDecay: -32768,
        volEnvSustain: -32768, volEnvRelease: -32768,
      };
      for (let i = genLo; i < genHi; i++) {
        const gen = iGens[i];
        switch (gen.oper) {
          case GEN_KEY_RANGE:       g.keyLo = gen.amount & 0xFF; g.keyHi = (gen.amount >> 8) & 0xFF; break;
          case GEN_VEL_RANGE:       g.velLo = gen.amount & 0xFF; g.velHi = (gen.amount >> 8) & 0xFF; break;
          case GEN_SAMPLE_ID:       g.sampleIndex = gen.amount & 0xFFFF; break;
          case GEN_OVERRIDING_ROOT_KEY: g.rootKey = gen.amount; break;
          case GEN_FINE_TUNE:       g.fineTune = gen.amount; break;
          case GEN_COARSE_TUNE:     g.coarseTune = gen.amount; break;
          case GEN_START_ADDRS_OFFSET:       g.startOffset = gen.amount; break;
          case GEN_END_ADDRS_OFFSET:         g.endOffset = gen.amount; break;
          case GEN_STARTLOOP_ADDRS_OFFSET:   g.startLoopOffset = gen.amount; break;
          case GEN_ENDLOOP_ADDRS_OFFSET:     g.endLoopOffset = gen.amount; break;
          case GEN_START_ADDRS_COARSE_OFFSET:     g.startCoarseOffset = gen.amount; break;
          case GEN_END_ADDRS_COARSE_OFFSET:       g.endCoarseOffset = gen.amount; break;
          case GEN_STARTLOOP_ADDRS_COARSE_OFFSET: g.startLoopCoarseOffset = gen.amount; break;
          case GEN_ENDLOOP_ADDRS_COARSE_OFFSET:   g.endLoopCoarseOffset = gen.amount; break;
          case GEN_SAMPLE_MODES:    g.sampleMode = gen.amount & 0x3; break;
          case GEN_VOL_ENV_ATTACK:  g.volEnvAttack = gen.amount; break;
          case GEN_VOL_ENV_DECAY:   g.volEnvDecay = gen.amount; break;
          case GEN_VOL_ENV_SUSTAIN: g.volEnvSustain = gen.amount; break;
          case GEN_VOL_ENV_RELEASE: g.volEnvRelease = gen.amount; break;
        }
      }
      return g;
    };

    /** Merge zone-level gens onto global defaults: zone wins, else global, else SF2 default. */
    const mergeWithGlobal = (zone, global) => {
      return {
        keyLo:     zone.keyLo >= 0     ? zone.keyLo     : (global.keyLo >= 0     ? global.keyLo     : 0),
        keyHi:     zone.keyHi >= 0     ? zone.keyHi     : (global.keyHi >= 0     ? global.keyHi     : 127),
        velLo:     zone.velLo >= 0     ? zone.velLo     : (global.velLo >= 0     ? global.velLo     : 0),
        velHi:     zone.velHi >= 0     ? zone.velHi     : (global.velHi >= 0     ? global.velHi     : 127),
        sampleIndex:   zone.sampleIndex,  // always from zone (not global)
        rootKey:       zone.rootKey >= 0  ? zone.rootKey  : global.rootKey,
        fineTune:      zone.fineTune      || global.fineTune      || 0,
        coarseTune:    zone.coarseTune    || global.coarseTune    || 0,
        startOffset:   zone.startOffset   || global.startOffset   || 0,
        endOffset:     zone.endOffset     || global.endOffset     || 0,
        startLoopOffset:   zone.startLoopOffset   || global.startLoopOffset   || 0,
        endLoopOffset:     zone.endLoopOffset     || global.endLoopOffset     || 0,
        startCoarseOffset:     zone.startCoarseOffset     || global.startCoarseOffset     || 0,
        endCoarseOffset:       zone.endCoarseOffset       || global.endCoarseOffset       || 0,
        startLoopCoarseOffset: zone.startLoopCoarseOffset || global.startLoopCoarseOffset || 0,
        endLoopCoarseOffset:   zone.endLoopCoarseOffset   || global.endLoopCoarseOffset   || 0,
        sampleMode:  zone.sampleMode >= 0   ? zone.sampleMode  : (global.sampleMode >= 0 ? global.sampleMode : 0),
        volEnvAttack:  zone.volEnvAttack  > -32768 ? zone.volEnvAttack  : (global.volEnvAttack  > -32768 ? global.volEnvAttack  : -12000),
        volEnvDecay:   zone.volEnvDecay   > -32768 ? zone.volEnvDecay   : (global.volEnvDecay   > -32768 ? global.volEnvDecay   : -12000),
        volEnvSustain: zone.volEnvSustain > -32768 ? zone.volEnvSustain : (global.volEnvSustain > -32768 ? global.volEnvSustain : 0),
        volEnvRelease: zone.volEnvRelease > -32768 ? zone.volEnvRelease : (global.volEnvRelease > -32768 ? global.volEnvRelease : -12000),
      };
    };

    for (let instIdx = 0; instIdx < instruments.length - 1; instIdx++) {
      const inst = instruments[instIdx];
      const nextInst = instruments[instIdx + 1];
      const bagLo = inst.bagIndex;
      const bagHi = nextInst.bagIndex;

      // ── Parse global zone (first bag if it has no sampleID) ──
      let globalGens = null;
      const firstBagGenLo = iBags[bagLo].genIndex;
      const firstBagGenHi = bagLo + 1 < iBags.length ? iBags[bagLo + 1].genIndex : iGens.length;
      const firstBag = parseGens(firstBagGenLo, firstBagGenHi);
      let startBag = bagLo;
      if (firstBag.sampleIndex < 0) {
        // This is a global zone — no sampleID, so it provides defaults
        globalGens = firstBag;
        startBag = bagLo + 1;  // skip it when iterating normal zones
      }
      const emptyGlobal = parseGens(0, 0);  // all defaults
      const gbl = globalGens || emptyGlobal;

      for (let bagIdx = startBag; bagIdx < bagHi; bagIdx++) {
        const genLo = iBags[bagIdx].genIndex;
        const genHi = bagIdx + 1 < iBags.length ? iBags[bagIdx + 1].genIndex : iGens.length;

        const zoneGens = parseGens(genLo, genHi);
        if (zoneGens.sampleIndex < 0 || zoneGens.sampleIndex >= this._sampleHeaders.length) continue;

        const m = mergeWithGlobal(zoneGens, gbl);
        const sh = this._sampleHeaders[m.sampleIndex];
        // Skip ROM samples and linked samples we can't use
        if (sh.sampleType > 1) continue;

        const zone = {
          keyLo:   m.keyLo,
          keyHi:   m.keyHi,
          velLo:   m.velLo,
          velHi:   m.velHi,
          sampleIndex: m.sampleIndex,
          instrumentIndex: instIdx,
          rootKey: m.rootKey >= 0 ? m.rootKey : sh.originalPitch,
          tuning: m.coarseTune * 100 + m.fineTune + sh.pitchCorrection,
          startOffset: sh.start + m.startOffset + m.startCoarseOffset * 32768,
          endOffset: sh.end + m.endOffset + m.endCoarseOffset * 32768,
          startLoop: sh.startLoop + m.startLoopOffset + m.startLoopCoarseOffset * 32768,
          endLoop: sh.endLoop + m.endLoopOffset + m.endLoopCoarseOffset * 32768,
          sampleRate: sh.sampleRate,
          loopMode: m.sampleMode,  // 0=no loop, 1=loop, 3=loop+release
          // Convert SF2 timecents → seconds: t = 2^(tc/1200)
          volAttack: Math.pow(2, m.volEnvAttack / 1200),
          volDecay: Math.pow(2, m.volEnvDecay / 1200),
          // Sustain: 0 cB = 1.0 level, 1000 cB = 0.0 level
          volSustain: Math.max(0, 1.0 - m.volEnvSustain / 1000),
          volRelease: Math.pow(2, m.volEnvRelease / 1200),
        };

        this._allZones.push(zone);
      }
    }

    // Default: use all zones until a preset is selected
    this._zones = this._allZones;
    console.log(`🎵 Built ${this._allZones.length} instrument zones`);
  }

  /* ────────────────────────────────────────────
   *  Preset parsing (phdr / pbag / pgen)
   * ──────────────────────────────────────────── */

  /** Parse phdr: 38-byte preset header records */
  _parsePresetHeaders(view, offset, size) {
    const recordSize = 38;
    const count = Math.floor(size / recordSize);
    const headers = [];
    for (let i = 0; i < count; i++) {
      const o = offset + i * recordSize;
      const name = this._readFixedString(view, o, 20);
      const preset = view.getUint16(o + 20, true);
      const bank = view.getUint16(o + 22, true);
      const bagIndex = view.getUint16(o + 24, true);
      // library(4), genre(4), morphology(4) — ignored
      headers.push({ name, preset, bank, bagIndex });
    }
    return headers;
  }

  /** Parse pbag: 4-byte preset bag records */
  _parsePBag(view, offset, size) {
    const count = Math.floor(size / 4);
    const bags = [];
    for (let i = 0; i < count; i++) {
      const o = offset + i * 4;
      const genIndex = view.getUint16(o, true);
      const modIndex = view.getUint16(o + 2, true);
      bags.push({ genIndex, modIndex });
    }
    return bags;
  }

  /** Parse pgen: 4-byte preset generator records */
  _parsePGen(view, offset, size) {
    const count = Math.floor(size / 4);
    const gens = [];
    for (let i = 0; i < count; i++) {
      const o = offset + i * 4;
      const oper = view.getUint16(o, true);
      const amount = view.getInt16(o + 2, true);
      gens.push({ oper, amount });
    }
    return gens;
  }

  /** Build the _presets list from parsed preset data */
  _buildPresets(presetHeaders, pBags, pGens) {
    this._presets = [];
    const GEN_INSTRUMENT = 41;  // SF2 generator that references an instrument

    for (let pi = 0; pi < presetHeaders.length - 1; pi++) {  // last entry is EOP terminal
      const ph = presetHeaders[pi];
      const nextPh = presetHeaders[pi + 1];
      const bagLo = ph.bagIndex;
      const bagHi = nextPh.bagIndex;

      const instrumentIndices = new Set();

      for (let bi = bagLo; bi < bagHi; bi++) {
        const genLo = pBags[bi].genIndex;
        const genHi = bi + 1 < pBags.length ? pBags[bi + 1].genIndex : pGens.length;

        for (let g = genLo; g < genHi; g++) {
          if (pGens[g].oper === GEN_INSTRUMENT) {
            instrumentIndices.add(pGens[g].amount & 0xFFFF);
          }
        }
      }

      this._presets.push({
        name: ph.name.trim(),
        preset: ph.preset,
        bank: ph.bank,
        instrumentIndices: [...instrumentIndices],
      });
    }

    console.log(`🎵 Parsed ${this._presets.length} presets:`,
      this._presets.slice(0, 10).map(p => `${p.preset}:${p.name}`).join(', '),
      this._presets.length > 10 ? '...' : '');
  }

  /** Build a fast MIDI-note → zone lookup */
  _buildNoteMap() {
    this._noteToZone.clear();
    for (let note = 0; note < 128; note++) {
      const zone = this._findZoneDirect(note, 80);
      if (zone) this._noteToZone.set(note, zone);
    }
  }

  /** Find the best zone for a given note and velocity */
  _findZone(midiNote, velocity = 80) {
    // Try the cached lookup first
    const cached = this._noteToZone.get(midiNote);
    if (cached) return cached;

    // Fall back to direct search
    return this._findZoneDirect(midiNote, velocity);
  }

  /** Direct zone search (uncached) */
  _findZoneDirect(midiNote, velocity) {
    let bestZone = null;
    let bestDistance = Infinity;

    for (const zone of this._zones) {
      if (midiNote >= zone.keyLo && midiNote <= zone.keyHi &&
          velocity >= zone.velLo && velocity <= zone.velHi) {
        // Exact match — prefer zones where rootKey is closest to the target note
        const dist = Math.abs(midiNote - zone.rootKey);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestZone = zone;
        }
      }
    }

    // If no exact match, find the nearest zone by key range
    if (!bestZone) {
      for (const zone of this._zones) {
        const mid = (zone.keyLo + zone.keyHi) / 2;
        const dist = Math.abs(midiNote - mid);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestZone = zone;
        }
      }
    }

    return bestZone;
  }

  /* ────────────────────────────────────────────
   *  Helpers
   * ──────────────────────────────────────────── */

  _getSample16(index) {
    if (!this._sampleData || index < 0 || index >= this._sampleData.length) return 0;
    return this._sampleData[index];
  }

  _readFourCC(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
  }

  _readFixedString(view, offset, length) {
    let str = '';
    for (let i = 0; i < length; i++) {
      const c = view.getUint8(offset + i);
      if (c === 0) break;
      str += String.fromCharCode(c);
    }
    return str;
  }

  _base64ToArrayBuffer(base64) {
    // Efficient base64 decode for React Native
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Uint8Array(256);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

    // Remove padding and whitespace
    const cleaned = base64.replace(/[^A-Za-z0-9+/]/g, '');
    const bufferLength = Math.floor(cleaned.length * 3 / 4);
    const bytes = new Uint8Array(bufferLength);

    let p = 0;
    for (let i = 0; i < cleaned.length; i += 4) {
      const a = lookup[cleaned.charCodeAt(i)];
      const b = lookup[cleaned.charCodeAt(i + 1)];
      const c = lookup[cleaned.charCodeAt(i + 2)];
      const d = lookup[cleaned.charCodeAt(i + 3)];

      bytes[p++] = (a << 2) | (b >> 4);
      if (i + 2 < cleaned.length) bytes[p++] = ((b & 15) << 4) | (c >> 2);
      if (i + 3 < cleaned.length) bytes[p++] = ((c & 3) << 6) | d;
    }

    return bytes.buffer;
  }
}

/** Singleton instance */
export const SoundFontService = new SoundFontServiceClass();
