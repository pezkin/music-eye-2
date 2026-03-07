import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
  StatusBar,
  Modal,
  FlatList,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { Feather } from '@expo/vector-icons';
import { AudioPlaybackService } from '../services/AudioPlaybackService';
import { PlaybackVisualization } from '../components/PlaybackVisualization';
import { ScoreInfoPanel } from '../components/ScoreInfoPanel';
import { OMRSettings } from '../services/OMRSettings';
import { OMRCacheService } from '../services/OMRCacheService';

/* ─── Theme ─── */
const palette = {
  background: '#F9F7F1',
  surface: '#FBFAF5',
  surfaceStrong: '#F1EEE4',
  border: '#D6D0C4',
  ink: '#3E3C37',
  inkMuted: '#6E675E',
};

const barPalette = {
  bar: '#1C1B19',
  barRaised: '#2A2925',
  barBorder: '#3C3A35',
  barText: '#F3F1EA',
  barTextMuted: '#C8C4BA',
  accent: '#E05A2A',
};

/* ─── Component ─── */
export const PlaybackScreen = ({ imageUri, onNavigateBack }) => {
  /* ── State ── */
  const [scoreData, setScoreData] = useState(null);
  const [scoreError, setScoreError] = useState(null);
  const [processing, setProcessing] = useState(true);
  const [processingStage, setProcessingStage] = useState('');

  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [tempo, setTempo] = useState(120);
  const [showTempoSlider, setShowTempoSlider] = useState(false);

  const [playbackTime, setPlaybackTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);

  // Instrument preset selection
  const [availablePresets, setAvailablePresets] = useState([]);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState(0);
  const [showInstrumentPicker, setShowInstrumentPicker] = useState(false);

  // Cursor data
  const [cursorInfo, setCursorInfo] = useState(null);

  const audioFileUriRef = useRef(null);
  const prepareIdRef = useRef(0);
  const referenceTempoRef = useRef(120);
  const tempoRenderTimerRef = useRef(null);

  const [voiceSelection, setVoiceSelection] = useState({
    Soprano: true,
    Alto: true,
    Tenor: true,
    Bass: true,
  });

  /* ── Process score via selected OMR engine (with caching) ── */
  const processScore = useCallback(async () => {
    if (!imageUri) return;
    setProcessing(true);
    setScoreError(null);
    const engine = OMRSettings.getEngine();
    const engineName = 'Audiveris';
    const service = OMRSettings.getService();
    const timeout = engine === 'audiveris' ? 180000 : 120000;

    // ── Check cache first ──
    setProcessingStage('Checking cache...');
    try {
      const cached = await OMRCacheService.get(imageUri, engine);
      if (cached && cached.notes && cached.notes.length > 0) {
        console.log(`🗂️ Cache hit — ${cached.notes.length} notes, skipping ${engineName}`);
        setScoreData(cached);
        setProcessing(false);
        setProcessingStage('');
        return;
      }
    } catch (e) {
      console.warn('Cache lookup failed, proceeding with OMR:', e.message);
    }

    // ── No cache — run OMR engine ──
    setProcessingStage(`Connecting to ${engineName} server...`);
    try {
      const result = await Promise.race([
        service.processSheet(imageUri, (stage) => setProcessingStage(stage)),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Processing timeout (${timeout / 1000}s)`)), timeout)),
      ]);
      console.log(`🎼 ${engineName} result: ${result.notes?.length || 0} notes, source=${result.metadata?.source}`);
      if (!result.notes || result.notes.length === 0) {
        setScoreError(`${engineName} could not detect any notes in this image. Try a clearer or higher-resolution photo.`);
      } else {
        setScoreData(result);
        // Store in cache for next time (async, don't block)
        OMRCacheService.set(imageUri, engine, result).catch(() => {});
      }
    } catch (e) {
      setScoreError(e?.message || 'Failed to process music sheet');
    } finally {
      setProcessing(false);
      setProcessingStage('');
    }
  }, [imageUri]);

  useEffect(() => {
    processScore();
    // Load SoundFont for high-quality playback (non-blocking)
    AudioPlaybackService.loadSoundFont(
      require('../../assets/SheetMusicScanner.sf2')
    ).then(() => {
      const presets = AudioPlaybackService.getAvailablePresets();
      if (presets.length > 0) {
        setAvailablePresets(presets);
        setSelectedPresetIndex(0);
      }
    });
  }, [processScore]);

  /* ── Phase 1: Pre-render voice tracks when scoreData or instrument changes ── */
  /* Audio is rendered once at a fixed reference tempo (120 BPM).                */
  /* Tempo changes are handled instantly via playback rate adjustment.           */
  useEffect(() => {
    if (!scoreData) return;
    let cancelled = false;

    AudioPlaybackService.initAudio();

    const doPreRender = async () => {
      const myId = ++prepareIdRef.current;
      setPreparing(true);
      try {
        AudioPlaybackService.selectPreset(selectedPresetIndex);
        const renderTempo = 120;
        referenceTempoRef.current = renderTempo;
        console.log(`🎹 preRender [${myId}]: rendering 4 voice tracks at ${renderTempo} BPM (reference)...`);

        const result = await AudioPlaybackService.preRenderVoiceTracks(scoreData.notes, renderTempo);

        if (cancelled || myId !== prepareIdRef.current) return;

        if (result) {
          // Pre-render succeeded — now do initial mix with current voice selection
          await doMix(myId);
        } else {
          // Fallback: no beatOffset data — use legacy path
          await legacyPrepare(myId);
        }
      } catch (e) {
        console.error(`preRender [${myId}] error:`, e);
        if (myId === prepareIdRef.current) {
          Alert.alert('Error', 'Failed to prepare audio: ' + e.message);
          setPreparing(false);
        }
      }
    };

    doPreRender();

    return () => {
      cancelled = true;
      if (AudioPlaybackService.sound) {
        try {
          AudioPlaybackService.sound.stopAsync().catch(() => {});
          AudioPlaybackService.sound.unloadAsync().catch(() => {});
        } catch (_) {}
        AudioPlaybackService.sound = null;
      }
      AudioPlaybackService.isPlaying = false;
    };
  }, [scoreData, selectedPresetIndex]);

  /* ── Tempo change: apply rate immediately, then re-render in background ── */
  useEffect(() => {
    const refTempo = referenceTempoRef.current;
    if (refTempo <= 0) return;
    // Instant rate-based preview (may have quality loss at extreme ratios)
    const rate = tempo / refTempo;
    AudioPlaybackService.setPlaybackRate(rate);

    // Schedule background re-render at the actual tempo for full quality
    if (tempoRenderTimerRef.current) clearTimeout(tempoRenderTimerRef.current);
    if (refTempo !== tempo) {
      tempoRenderTimerRef.current = setTimeout(() => {
        reRenderAtTempo(tempo);
      }, 600);
    }

    return () => {
      if (tempoRenderTimerRef.current) clearTimeout(tempoRenderTimerRef.current);
    };
  }, [tempo]);

  /* ── Phase 2: Quick mix when voice selection changes (no re-render needed) ── */
  useEffect(() => {
    if (!scoreData) return;
    if (!AudioPlaybackService.hasPreRenderedTracks()) return; // not ready yet

    let cancelled = false;
    const myId = ++prepareIdRef.current;

    // Stop playback before remixing
    if (AudioPlaybackService.sound) {
      try {
        AudioPlaybackService.sound.stopAsync().catch(() => {});
        AudioPlaybackService.sound.unloadAsync().catch(() => {});
      } catch (_) {}
      AudioPlaybackService.sound = null;
    }
    AudioPlaybackService.isPlaying = false;
    setIsPlaying(false);
    setIsPaused(false);

    doMix(myId).then(() => {
      if (cancelled) return;
    });

    return () => { cancelled = true; };
  }, [voiceSelection]);

  /**
   * Background re-render at the actual tempo for full audio quality.
   * Called automatically after tempo changes settle (debounced 400ms).
   */
  const reRenderAtTempo = async (newTempo) => {
    if (!scoreData) return;
    if (referenceTempoRef.current === newTempo) return;

    const myId = ++prepareIdRef.current;
    try {
      AudioPlaybackService.selectPreset(selectedPresetIndex);
      const result = await AudioPlaybackService.preRenderVoiceTracks(
        scoreData.notes, newTempo
      );
      if (myId !== prepareIdRef.current) return;
      if (!result) return;

      referenceTempoRef.current = newTempo;

      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.mixVoiceTracks(voiceSelection);
      if (myId !== prepareIdRef.current) return;

      // Read playback state directly from service (not stale React closure)
      const wasPlaying = AudioPlaybackService.isPlaying;

      // Stop current sound so next play uses the new file
      if (AudioPlaybackService.sound) {
        try {
          await AudioPlaybackService.sound.stopAsync();
          await AudioPlaybackService.sound.unloadAsync();
        } catch (_) {}
        AudioPlaybackService.sound = null;
      }
      AudioPlaybackService.isPlaying = false;

      audioFileUriRef.current = fileUri;
      setTotalDuration(dur);
      buildCursorInfo(timingMap);

      // If was playing, auto-restart at rate=1.0 (now with correct tempo audio)
      if (wasPlaying) {
        setIsPlaying(true);
        setIsPaused(false);
        setPlaybackTime(0);
        await AudioPlaybackService.play(
          fileUri,
          (timeSec) => setPlaybackTime(timeSec),
          () => { setIsPlaying(false); setIsPaused(false); setPlaybackTime(dur); },
          1.0
        );
      }

      console.log(`✅ Tempo re-render: ${newTempo} BPM (rate → 1.0)`);
    } catch (e) {
      console.warn('Tempo re-render error:', e);
    }
  };

  /** Mix pre-rendered voice buffers into a single WAV based on current voiceSelection */
  const doMix = async (myId) => {
    audioFileUriRef.current = null;
    setPreparing(true);
    try {
      // Check at least one voice has notes
      const activeVoices = Object.entries(voiceSelection)
        .filter(([, v]) => v).map(([k]) => k);
      console.log(`🎵 mix [${myId}]: voices=${activeVoices.join(',')}`);

      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.mixVoiceTracks(voiceSelection);

      if (myId !== prepareIdRef.current) {
        console.log(`🎵 mix [${myId}]: stale, abandoning`);
        return;
      }

      if (!fileUri || !timingMap.length || dur <= 0) {
        Alert.alert('No playable notes', 'No notes detected for playback.');
        audioFileUriRef.current = null;
        setCursorInfo(null);
        setTotalDuration(0);
        setPreparing(false);
        return;
      }

      audioFileUriRef.current = fileUri;
      setTotalDuration(dur);
      setPlaybackTime(0);
      buildCursorInfo(timingMap);

      console.log(`✅ Audio ready [${myId}]: ${dur.toFixed(1)}s, file=${fileUri ? 'OK' : 'MISSING'}`);
    } catch (e) {
      console.error(`mix [${myId}] error:`, e);
      if (myId === prepareIdRef.current) {
        audioFileUriRef.current = null;
        Alert.alert('Error', 'Failed to mix audio: ' + e.message);
      }
    } finally {
      if (myId === prepareIdRef.current) {
        setPreparing(false);
      }
    }
  };

  /** Legacy path: full re-render when beatOffset is unavailable */
  const legacyPrepare = async (myId) => {
    audioFileUriRef.current = null;
    setPreparing(true);
    try {
      const filteredNotes = scoreData.notes.filter(
        (n) => n.type === 'rest' || voiceSelection[n.voice]
      );
      const playableCount = filteredNotes.filter((n) => n.type !== 'rest').length;
      if (playableCount === 0) {
        Alert.alert('No Notes', 'No notes found for the selected voice(s)');
        setPreparing(false);
        return;
      }

      const systemsMetadata = scoreData.metadata?.systems || null;
      const { fileUri, timingMap, totalDuration: dur } =
        await AudioPlaybackService.createCombinedAudio(filteredNotes, tempo, systemsMetadata);

      if (myId !== prepareIdRef.current) return;

      if (!fileUri || !timingMap.length || dur <= 0) {
        Alert.alert('No playable notes', 'No notes detected for playback.');
        setPreparing(false);
        return;
      }

      audioFileUriRef.current = fileUri;
      setTotalDuration(dur);
      setPlaybackTime(0);
      buildCursorInfo(timingMap);

      console.log(`✅ Audio ready (legacy) [${myId}]: ${dur.toFixed(1)}s`);
    } catch (e) {
      console.error(`legacyPrepare [${myId}] error:`, e);
      if (myId === prepareIdRef.current) {
        Alert.alert('Error', 'Failed to prepare audio: ' + e.message);
      }
    } finally {
      if (myId === prepareIdRef.current) {
        setPreparing(false);
      }
    }
  };

  /** Build cursor positioning data from a timing map */
  const buildCursorInfo = (timingMap) => {
    const imgW = scoreData.metadata?.imageWidth || 1;
    const imgH = scoreData.metadata?.imageHeight || 1;
    const metaSystems = scoreData.metadata?.systems || [];
    const staffGroups = scoreData.metadata?.staffGroups || [];

    let systemBounds;
    if (metaSystems.length > 0) {
      systemBounds = metaSystems.map((sys) => ({
        top: sys.top, bottom: sys.bottom, staffIndices: sys.staffIndices,
      }));
    } else {
      systemBounds = [];
      let si = 0;
      while (si < staffGroups.length) {
        const a = staffGroups[si];
        const b = staffGroups[si + 1];
        const topA = Math.min(...a);
        const botA = Math.max(...a);
        if (b) {
          const topB = Math.min(...b);
          const botB = Math.max(...b);
          if (topB - botA < (botA - topA) * 2.5) {
            systemBounds.push({ top: topA, bottom: botB, staffIndices: [si, si + 1] });
            si += 2;
            continue;
          }
        }
        systemBounds.push({ top: topA, bottom: botA, staffIndices: [si] });
        si += 1;
      }
    }

    const xValues = timingMap.map((e) => e.x);
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    const rangeX = Math.max(1, maxX - minX);

    const positions = timingMap.map((entry) => {
      const ratio = (entry.x - minX) / rangeX;
      // Use systemIndex directly from the timing map (set by AudiverisService)
      const sysIdx = entry.systemIndex ?? 0;
      return { time: entry.time, ratio: Math.max(0, Math.min(1, ratio)), systemIndex: sysIdx, y: entry.y };
    });

    setCursorInfo({
      positions, systemBounds,
      imageWidth: imgW, imageHeight: imgH,
      xRange: { min: minX, max: maxX },
    });
  };

  /* ── Playback controls ── */
  const handlePlay = async () => {
    if (preparing) return; // Still building audio
    if (!audioFileUriRef.current) {
      console.warn('handlePlay: audioFileUriRef is null');
      Alert.alert('Not Ready', 'Audio is still preparing. Please wait.');
      return;
    }

    if (isPaused) {
      const rate = tempo / referenceTempoRef.current;
      await AudioPlaybackService.setPlaybackRate(rate);
      await AudioPlaybackService.resume();
      setIsPlaying(true);
      setIsPaused(false);
      return;
    }

    setIsPlaying(true);
    setIsPaused(false);
    setPlaybackTime(0);

    const fileUri = audioFileUriRef.current;
    const rate = tempo / referenceTempoRef.current;
    console.log(`▶️ handlePlay: playing ${fileUri} at rate=${rate.toFixed(2)}`);

    try {
      await AudioPlaybackService.play(
        fileUri,
        (timeSec) => setPlaybackTime(timeSec),
        () => {
          setIsPlaying(false);
          setIsPaused(false);
          setPlaybackTime(totalDuration);
        },
        rate
      );
    } catch (e) {
      console.error('Play error:', e);
      setIsPlaying(false);
    }
  };

  const handlePause = async () => {
    await AudioPlaybackService.pause();
    setIsPlaying(false);
    setIsPaused(true);
  };

  const handleStop = async () => {
    await AudioPlaybackService.stop();
    setIsPlaying(false);
    setIsPaused(false);
    setPlaybackTime(0);
  };

  const handleSeek = async (timeSec) => {
    const clamped = Math.max(0, Math.min(timeSec, totalDuration));
    setPlaybackTime(clamped);
    await AudioPlaybackService.seekTo(clamped);
  };

  const toggleVoice = (voice) => {
    // Stop playback so audio re-prepares with new voice selection
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    setVoiceSelection((prev) => {
      const next = { ...prev, [voice]: !prev[voice] };
      if (!Object.values(next).some(Boolean)) {
        Alert.alert('Select Voice', 'At least one voice must be selected');
        return prev;
      }
      return next;
    });
  };

  const soloVoice = (voice) => {
    // Stop playback so audio re-prepares
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    setVoiceSelection((prev) => {
      const activeCount = Object.values(prev).filter(Boolean).length;
      const onlyThisActive = prev[voice] && activeCount === 1;

      if (onlyThisActive) {
        // Already solo'd on this voice — re-enable all
        console.log(`🎤 unsolo ${voice} → all voices on`);
        return { Soprano: true, Alto: true, Tenor: true, Bass: true };
      }

      // Solo this voice (deactivate all others)
      console.log(`🎤 solo ${voice}`);
      return {
        Soprano: voice === 'Soprano',
        Alto: voice === 'Alto',
        Tenor: voice === 'Tenor',
        Bass: voice === 'Bass',
      };
    });
  };

  const allVoicesOn = () => {
    if (isPlaying || isPaused) {
      AudioPlaybackService.stop();
      setIsPlaying(false);
      setIsPaused(false);
      setPlaybackTime(0);
    }
    setVoiceSelection({ Soprano: true, Alto: true, Tenor: true, Bass: true });
  };

  /* ── Instrument selection ── */
  const handleSelectInstrument = (presetIndex) => {
    if (isPlaying) return;
    setSelectedPresetIndex(presetIndex);
    setShowInstrumentPicker(false);
  };

  const currentInstrumentName = availablePresets[selectedPresetIndex]?.name || 'Piano';

  // Compute current beat position from playback time + tempo
  const currentBeat = totalDuration > 0 ? (playbackTime / (60 / tempo)) : 0;

  /* ── Render ── */
  if (processing) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={palette.background} />
        <ActivityIndicator size="large" color={palette.ink} />
        <Text style={styles.loadingText}>Analyzing score...</Text>
        {processingStage ? (
          <Text style={styles.stageText}>{processingStage}</Text>
        ) : null}
        <Text style={styles.hintText}>
          Sending image to server for recognition
        </Text>
      </View>
    );
  }

  if (scoreError || !scoreData) {
    return (
      <View style={styles.centerContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={palette.background} />
        <Text style={styles.errorTitle}>Unable to load score</Text>
        <Text style={styles.errorText}>{scoreError || 'Unknown error'}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={processScore}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.retryButton, { marginTop: 10 }]} onPress={onNavigateBack}>
          <Text style={styles.retryButtonText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={palette.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onNavigateBack}>
          <Text style={styles.linkText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>
          {scoreData.metadata?.title || 'Score Viewer'}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Score + cursor */}
      <View style={styles.viewerArea}>
        <PlaybackVisualization
          imageUri={scoreData?.processedImageUri || imageUri}
          currentTime={playbackTime}
          totalDuration={totalDuration}
          isPlaying={isPlaying}
          cursorInfo={cursorInfo}
          onSeek={handleSeek}
          measureBeats={scoreData.metadata?.measureBeats}
          tempo={tempo}
        />
      </View>

      {/* Tempo slider drawer */}
      {showTempoSlider && (
        <View style={styles.tempoDrawer}>
          <View style={styles.tempoDrawerRow}>
            <Text style={styles.tempoDrawerLabel}>Tempo</Text>
            <Text style={styles.tempoDrawerValue}>♩ = {tempo}</Text>
          </View>
          <Slider
            style={styles.tempoSlider}
            minimumValue={40}
            maximumValue={240}
            step={1}
            value={tempo}
            onValueChange={(v) => setTempo(Math.round(v))}
            minimumTrackTintColor={barPalette.accent}
            maximumTrackTintColor={barPalette.barBorder}
            thumbTintColor={barPalette.accent}
          />
          <View style={styles.tempoPresets}>
            {[
              { label: 'Largo',    bpm: 50 },
              { label: 'Adagio',   bpm: 72 },
              { label: 'Andante',  bpm: 92 },
              { label: 'Moderato', bpm: 108 },
              { label: 'Allegro',  bpm: 132 },
              { label: 'Presto',   bpm: 180 },
            ].map((p) => (
              <TouchableOpacity
                key={p.label}
                style={[
                  styles.tempoPresetBtn,
                  Math.abs(tempo - p.bpm) < 10 && styles.tempoPresetBtnActive,
                ]}
                onPress={() => setTempo(p.bpm)}
              >
                <Text
                  style={[
                    styles.tempoPresetText,
                    Math.abs(tempo - p.bpm) < 10 && styles.tempoPresetTextActive,
                  ]}
                >
                  {p.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Transport bar */}
      <View style={styles.bottomBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.barScroll}
        >
          {/* Play / Pause */}
          <Pressable
            style={({ pressed }) => [styles.playPill, pressed && styles.pressedPill]}
            onPress={isPlaying ? handlePause : handlePlay}
            disabled={preparing}
          >
            <Feather
              name={isPlaying ? 'pause' : 'play'}
              size={14}
              color={barPalette.barText}
            />
            <Text style={styles.playPillText}>
              {preparing ? 'Preparing...' : isPlaying ? 'Pause' : isPaused ? 'Resume' : 'Play'}
            </Text>
          </Pressable>

          {/* Stop */}
          <Pressable style={({ pressed }) => [styles.iconPill, pressed && styles.pressedPill]} onPress={handleStop}>
            <Feather name="square" size={14} color={barPalette.barText} />
          </Pressable>

          {/* Tempo */}
          <Pressable
            style={({ pressed }) => [styles.zoomPill, showTempoSlider && { borderColor: barPalette.accent }, pressed && styles.pressedPill]}
            onPress={() => setShowTempoSlider((v) => !v)}
          >
            <Feather name="activity" size={12} color={barPalette.barTextMuted} />
            <Text style={styles.pillText}>{tempo} BPM</Text>
          </Pressable>

          {/* Voice toggles: tap = solo, long press = toggle */}
          <View style={styles.voicePill}>
            {/* All button */}
            <Pressable
              style={({ pressed }) => [
                styles.voiceDot,
                Object.values(voiceSelection).every(Boolean)
                  ? styles.voiceDotAll
                  : styles.voiceDotInactive,
                pressed && styles.pressedDot,
              ]}
              onPress={allVoicesOn}
            >
              <Text
                style={[
                  styles.voiceDotText,
                  Object.values(voiceSelection).every(Boolean)
                    ? styles.voiceDotTextActive
                    : styles.voiceDotTextInactive,
                ]}
              >
                All
              </Text>
            </Pressable>
            {Object.keys(voiceSelection).map((voice) => {
              const vc = scoreData?.metadata?.voiceCounts || {};
              const hasVoiceCounts = Object.keys(vc).length > 0;
              const cnt = vc[voice] || 0;
              // Only disable if we KNOW voice counts and this voice has 0 notes
              const isEmpty = hasVoiceCounts && cnt === 0;
              return (
              <Pressable
                key={voice}
                style={({ pressed }) => [
                  styles.voiceDot,
                  isEmpty
                    ? styles.voiceDotEmpty
                    : voiceSelection[voice]
                      ? styles.voiceDotActive
                      : styles.voiceDotInactive,
                  pressed && !isEmpty && styles.pressedDot,
                ]}
                onPress={() => isEmpty ? null : soloVoice(voice)}
                onLongPress={() => isEmpty ? null : toggleVoice(voice)}
                disabled={isEmpty}
              >
                <Text
                  style={[
                    styles.voiceDotText,
                    isEmpty
                      ? styles.voiceDotTextInactive
                      : voiceSelection[voice]
                        ? styles.voiceDotTextActive
                        : styles.voiceDotTextInactive,
                  ]}
                >
                  {voice.charAt(0)}{isEmpty ? '⊘' : ''}
                </Text>
              </Pressable>
              );
            })}
          </View>

          {/* Progress indicator */}
          <View style={styles.viewPill}>
            <Text style={styles.pillText}>
              {formatTime(playbackTime)} / {formatTime(totalDuration)}
            </Text>
          </View>

          {/* Score info button (compact pill) */}
          <ScoreInfoPanel
            metadata={scoreData.metadata}
            currentBeat={currentBeat}
            isPlaying={isPlaying}
          />

          {/* Instrument selector */}
          {availablePresets.length > 0 && (
            <Pressable
              style={({ pressed }) => [
                styles.zoomPill,
                showInstrumentPicker && { borderColor: barPalette.accent },
                pressed && styles.pressedPill,
              ]}
              onPress={() => !isPlaying && setShowInstrumentPicker(true)}
              disabled={isPlaying}
            >
              <Feather name="music" size={12} color={barPalette.barTextMuted} />
              <Text style={styles.pillText} numberOfLines={1}>
                {currentInstrumentName}
              </Text>
            </Pressable>
          )}
        </ScrollView>
      </View>

      {/* Instrument picker modal */}
      <Modal
        visible={showInstrumentPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowInstrumentPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Instrument</Text>
              <TouchableOpacity onPress={() => setShowInstrumentPicker(false)}>
                <Feather name="x" size={22} color={palette.ink} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={availablePresets}
              keyExtractor={(item) => String(item.index)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.instrumentRow,
                    item.index === selectedPresetIndex && styles.instrumentRowActive,
                  ]}
                  onPress={() => handleSelectInstrument(item.index)}
                >
                  <Text
                    style={[
                      styles.instrumentName,
                      item.index === selectedPresetIndex && styles.instrumentNameActive,
                    ]}
                  >
                    {item.name}
                  </Text>
                  {item.index === selectedPresetIndex && (
                    <Feather name="check" size={16} color={barPalette.accent} />
                  )}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
};

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ─── Styles ─── */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: palette.background,
  },
  loadingText: { marginTop: 16, fontSize: 15, color: palette.inkMuted, fontWeight: '600' },
  stageText: { marginTop: 8, fontSize: 13, color: barPalette.accent, fontWeight: '600' },
  hintText: { marginTop: 12, fontSize: 12, color: palette.inkMuted, textAlign: 'center' },
  errorTitle: { fontSize: 18, fontWeight: '700', color: palette.ink, marginBottom: 8 },
  errorText: { fontSize: 13, color: palette.inkMuted, textAlign: 'center', marginBottom: 16, paddingHorizontal: 16 },
  retryButton: {
    backgroundColor: palette.surface,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: palette.border,
  },
  retryButtonText: {
    color: palette.ink,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) + 20 : 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: palette.background,
  },
  title: { fontSize: 24, fontWeight: '800', color: palette.ink, letterSpacing: -0.4 },
  linkText: { fontSize: 14, color: palette.inkMuted, fontWeight: '600' },
  viewerArea: {
    flex: 1,
    backgroundColor: '#fff',
    marginHorizontal: 12,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E6E2D8',
  },
  tempoDrawer: {
    backgroundColor: barPalette.barRaised,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  tempoDrawerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  tempoDrawerLabel: {
    color: barPalette.barTextMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  tempoDrawerValue: {
    color: barPalette.accent,
    fontSize: 14,
    fontWeight: '800',
  },
  tempoSlider: {
    width: '100%',
    height: 32,
  },
  tempoPresets: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  tempoPresetBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: barPalette.bar,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  tempoPresetBtnActive: {
    backgroundColor: barPalette.accent,
    borderColor: barPalette.accent,
  },
  tempoPresetText: {
    color: barPalette.barTextMuted,
    fontSize: 10,
    fontWeight: '700',
  },
  tempoPresetTextActive: {
    color: barPalette.barText,
  },
  bottomBar: {
    backgroundColor: barPalette.bar,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 38 : 24,
    borderTopWidth: 1,
    borderTopColor: barPalette.barBorder,
  },
  barScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  playPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  playPillText: { color: barPalette.barText, fontSize: 12, fontWeight: '700' },
  zoomPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  pillText: { color: barPalette.barText, fontSize: 12, fontWeight: '600' },
  voicePill: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  voiceDot: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 4,
  },
  voiceDotActive: { backgroundColor: barPalette.accent, borderColor: barPalette.accent },
  voiceDotAll: { backgroundColor: '#2A7B3D', borderColor: '#2A7B3D' },
  voiceDotEmpty: { backgroundColor: barPalette.bar, borderColor: '#555', opacity: 0.4 },
  voiceDotInactive: { backgroundColor: barPalette.bar, borderColor: barPalette.barBorder },
  voiceDotText: { fontSize: 11, fontWeight: '700' },
  voiceDotTextActive: { color: barPalette.barText },
  voiceDotTextInactive: { color: barPalette.barTextMuted },
  viewPill: {
    backgroundColor: barPalette.barRaised,
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  iconPill: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: barPalette.barRaised,
    borderWidth: 1,
    borderColor: barPalette.barBorder,
  },
  pressedPill: {
    opacity: 0.6,
    transform: [{ scale: 0.96 }],
  },
  pressedDot: {
    opacity: 0.6,
    transform: [{ scale: 0.9 }],
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: palette.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '60%',
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: palette.ink,
    letterSpacing: -0.3,
  },
  instrumentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  instrumentRowActive: {
    backgroundColor: palette.surfaceStrong,
  },
  instrumentName: {
    fontSize: 14,
    fontWeight: '600',
    color: palette.ink,
    flex: 1,
  },
  instrumentNameActive: {
    color: barPalette.accent,
    fontWeight: '800',
  },
});
