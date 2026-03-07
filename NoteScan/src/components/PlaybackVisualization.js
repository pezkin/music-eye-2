import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  ScrollView,
  Pressable,
} from 'react-native';

const ACCENT = '#E05A2A';
const ACCENT_LIGHT = 'rgba(224, 90, 42, 0.18)';
const BAR_HEIGHT = 6;

/**
 * Score viewer — fit-width with vertical scroll & native pinch-to-zoom.
 *
 *  - Image scaled to fill container width (readable on iPhone 12)
 *  - Vertical scroll through systems
 *  - Native iOS pinch-to-zoom (1×–3×)
 *  - Orange cursor bar + note highlights during playback
 *  - Auto-scroll vertically to follow the current system
 *  - Tap-to-seek on both the sheet image and progress bar
 */
export const PlaybackVisualization = ({
  imageUri,
  currentTime,
  totalDuration,
  isPlaying,
  cursorInfo,
  onSeek,
  measureBeats,
  tempo,
}) => {
  const scrollViewRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [imageNaturalWidth, setImageNaturalWidth] = useState(0);
  const [imageNaturalHeight, setImageNaturalHeight] = useState(0);
  const prevSystemRef = useRef(-1);



  // Load natural image dimensions
  useEffect(() => {
    if (!imageUri) return;
    Image.getSize(
      imageUri,
      (w, h) => {
        setImageNaturalWidth(w);
        setImageNaturalHeight(h);
      },
      () => {}
    );
  }, [imageUri]);

  // ─── Cursor data ───
  const positions = cursorInfo?.positions || [];
  const systemBounds = cursorInfo?.systemBounds || [];
  const xRange = cursorInfo?.xRange || { min: 0, max: 1 };
  const rangeSpan = Math.max(1, xRange.max - xRange.min);

  // Find active cursor index
  let activeIndex = 0;
  if (positions.length > 0) {
    for (let i = 0; i < positions.length; i++) {
      if (currentTime >= positions[i].time) {
        activeIndex = i;
      } else {
        break;
      }
    }
  }

  const activeEntry = positions[activeIndex] || null;
  const nextEntry = positions[activeIndex + 1] || null;
  const activeSystemIndex = activeEntry?.systemIndex ?? 0;

  // ─── Smooth lerp between current and next position ───
  let activeRatio = activeEntry?.ratio ?? 0;
  if (activeEntry && nextEntry) {
    const elapsed = currentTime - activeEntry.time;
    const span = nextEntry.time - activeEntry.time;
    if (span > 0) {
      const t = Math.max(0, Math.min(1, elapsed / span));
      activeRatio = activeEntry.ratio + t * (nextEntry.ratio - activeEntry.ratio);
    }
  }

  const system = systemBounds[activeSystemIndex];

  // ─── Layout: fit WIDTH to container, vertical scroll for height ───
  const hasImage = imageNaturalWidth > 0 && imageNaturalHeight > 0;
  let zoomScale = 1;
  let renderWidth = containerWidth || 390;
  let renderHeight = 400;

  if (hasImage && containerWidth > 0) {
    zoomScale = containerWidth / imageNaturalWidth;
    renderWidth = containerWidth;
    renderHeight = imageNaturalHeight * zoomScale;
  }

  // ─── Cursor position in zoomed-image coordinates ───
  const cursorImageX = xRange.min + activeRatio * rangeSpan;
  const cursorX = cursorImageX * zoomScale;
  const clampedCursorX = Math.max(0, Math.min(cursorX, renderWidth - 3));

  let cursorTop = 0;
  let cursorHeight = renderHeight;
  if (system) {
    const pad = Math.max(4, (system.bottom - system.top) * 0.1);
    cursorTop = (system.top - pad) * zoomScale;
    cursorHeight = (system.bottom - system.top + pad * 2) * zoomScale;
  }

  // ─── Progress ratio ───
  const progressRatio =
    totalDuration > 0 ? Math.max(0, Math.min(1, currentTime / totalDuration)) : 0;

  // ─── Vertical auto-scroll to current system ───
  useEffect(() => {
    if (!scrollViewRef.current || !system) return;
    if (!(isPlaying || currentTime > 0) || positions.length === 0) return;
    // Only scroll when the system changes (don't fight user's manual scrolling)
    if (activeSystemIndex === prevSystemRef.current) return;
    prevSystemRef.current = activeSystemIndex;

    const sysMidY = ((system.top + system.bottom) / 2) * zoomScale;
    const targetY = Math.max(0, sysMidY - containerHeight * 0.35);
    scrollViewRef.current.scrollTo({ y: targetY, animated: true });
  }, [activeSystemIndex, isPlaying]);

  const showCursor = (isPlaying || currentTime > 0) && positions.length > 0;

  // ─── Tap-to-seek on the sheet image ───
  const handleSheetPress = useCallback(
    (evt) => {
      if (!onSeek || positions.length === 0) return;

      const { locationX, locationY } = evt.nativeEvent;
      const tapImgX = locationX / zoomScale;
      const tapImgY = locationY / zoomScale;

      // Find which system was tapped
      let tappedSystemIdx = -1;
      for (let i = 0; i < systemBounds.length; i++) {
        const sys = systemBounds[i];
        const pad = Math.max(10, (sys.bottom - sys.top) * 0.3);
        if (tapImgY >= sys.top - pad && tapImgY <= sys.bottom + pad) {
          tappedSystemIdx = i;
          break;
        }
      }

      // Find nearest cursor position in that system
      let bestIdx = 0;
      let bestDist = Infinity;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (tappedSystemIdx >= 0 && pos.systemIndex !== tappedSystemIdx) continue;
        const posImgX = xRange.min + pos.ratio * rangeSpan;
        const dist = Math.abs(posImgX - tapImgX);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      // Fallback: global nearest
      if (bestDist === Infinity) {
        for (let i = 0; i < positions.length; i++) {
          const posImgX = xRange.min + positions[i].ratio * rangeSpan;
          const dist = Math.abs(posImgX - tapImgX);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }
      }

      onSeek(positions[bestIdx].time);
    },
    [onSeek, positions, systemBounds, zoomScale, xRange, rangeSpan]
  );

  // ─── Tap on the progress bar ───
  const handleProgressBarPress = useCallback(
    (evt) => {
      if (!onSeek || totalDuration <= 0) return;
      const { locationX } = evt.nativeEvent;
      const ratio = Math.max(0, Math.min(1, locationX / containerWidth));
      onSeek(ratio * totalDuration);
    },
    [onSeek, totalDuration, containerWidth]
  );

  return (
    <View
      style={styles.container}
      onLayout={(e) => {
        setContainerWidth(e.nativeEvent.layout.width);
        setContainerHeight(e.nativeEvent.layout.height);
      }}
    >
      {/* ─── Progress bar (scrubber) ─── */}
      <Pressable onPress={handleProgressBarPress} style={styles.progressBarOuter}>
        <View style={styles.progressBarTrack}>
          {measureBeats && measureBeats.length > 1 && totalDuration > 0 && tempo > 0 && (
            measureBeats.slice(1).map((mb, i) => {
              const secPerBeat = 60 / tempo;
              const markerTime = mb.startBeat * secPerBeat;
              const pct = (markerTime / totalDuration) * 100;
              if (pct <= 0 || pct >= 100) return null;
              return (
                <View key={`m-${i}`} style={[styles.measureMarker, { left: `${pct}%` }]}>
                  {(mb.measureNum % Math.max(1, Math.ceil(measureBeats.length / 12)) === 0 ||
                    mb.measureNum === 1) && (
                    <Text style={styles.measureMarkerNum}>{mb.measureNum}</Text>
                  )}
                </View>
              );
            })
          )}
          <View style={[styles.progressBarFill, { width: `${progressRatio * 100}%` }]} />
          {showCursor && (
            <View style={[styles.progressThumb, { left: `${progressRatio * 100}%` }]} />
          )}
        </View>
      </Pressable>

      {/* ─── Vertically-scrolling sheet music with native pinch-to-zoom ─── */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        maximumZoomScale={3}
        minimumZoomScale={1}
        bouncesZoom
      >
        {imageUri ? (
          <Pressable onPress={handleSheetPress}>
            <View style={{ width: renderWidth, height: renderHeight, position: 'relative' }}>
              <Image
                source={{ uri: imageUri }}
                style={{ width: renderWidth, height: renderHeight }}
                resizeMode="contain"
              />

              {/* Vertical cursor bar */}
              {showCursor && (
                <View
                  style={[
                    styles.cursor,
                    { left: clampedCursorX, top: cursorTop, height: cursorHeight },
                  ]}
                />
              )}

              {/* Played-region highlight */}
              {showCursor && system && (
                <View
                  style={[
                    styles.systemHighlight,
                    { top: cursorTop, height: cursorHeight, width: clampedCursorX },
                  ]}
                />
              )}
            </View>
          </Pressable>
        ) : (
          <View style={styles.noImage}>
            <Text style={styles.noImageText}>No sheet image</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  /* ─── Progress bar ─── */
  progressBarOuter: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#FAFAF7',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E6E2D8',
  },
  progressBarTrack: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: '#E8E4DA',
    overflow: 'visible',
    position: 'relative',
  },
  measureMarker: {
    position: 'absolute',
    top: -2,
    width: 1,
    height: BAR_HEIGHT + 4,
    backgroundColor: 'rgba(62, 60, 55, 0.2)',
    zIndex: 1,
  },
  measureMarkerNum: {
    position: 'absolute',
    top: BAR_HEIGHT + 5,
    fontSize: 7,
    color: '#999',
    fontWeight: '700',
    textAlign: 'center',
    width: 16,
    marginLeft: -8,
  },
  progressBarFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    backgroundColor: ACCENT,
  },
  progressThumb: {
    position: 'absolute',
    top: -(10 - BAR_HEIGHT) / 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: ACCENT,
    marginLeft: -5,
    borderWidth: 2,
    borderColor: '#fff',
    elevation: 3,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.4,
    shadowRadius: 2,
  },
  /* ─── Sheet area ─── */
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  /* ─── Cursor & highlights ─── */
  cursor: {
    position: 'absolute',
    width: 3,
    backgroundColor: ACCENT,
    borderRadius: 2,
    opacity: 0.9,
    zIndex: 10,
  },
  systemHighlight: {
    position: 'absolute',
    left: 0,
    backgroundColor: ACCENT_LIGHT,
    zIndex: 5,
  },
  noImage: {
    height: 200,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  noImageText: {
    fontSize: 14,
    color: '#999',
  },
});
