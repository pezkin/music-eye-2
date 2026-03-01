"""
Advanced image preprocessing for OMR (Optical Music Recognition).

TWO-STAGE STAFF-AWARE PIPELINE (Zemsky-inspired):

  Stage A — Quick pre-clean + staff detection
    Raw camera photo
      → Auto-crop             (remove desk/background around page)
      → Perspective correction (straighten tilted shots)
      → Dewarp                (flatten curved pages / book spines)
      → Quick Otsu binarize   (just for staff detection)
      → ★ Staff detection ★   (horizontal RLE projection → 5-line groups)

  Stage B — Staff-guided corrections
      → Staff-guided deskew   (use actual staff angle, not Hough guessing)
      → Staff-guided resize   (normalize interline to ideal 20px for Audiveris)
      → Sharpen               (recover phone-camera blur via unsharp mask)
      → Smart binarize        (Sauvola first, Adobe-Scan fallback)
      → Close gaps            (reconnect broken staff lines)
      → Staff-aware denoise   (aggressive far from staves, gentle near them)
      → Clean B&W image ready for Audiveris

Key insight: staff lines are the most robust visual feature in any photo
of sheet music.  By detecting them FIRST, we use their geometry (angle,
spacing, y-positions) to guide every subsequent correction — making even
careless phone photos look like clean scans before Audiveris sees them.

Inspired by Zemsky's Sheet Music Scanner (staffaDetect) and Leptonica:
  - staffaDetect / rleGetRowRuns → our _detect_staffs()
  - pixSauvolaBinarize           → our _sauvola()
  - dewarpBuildPageModel         → our _dewarp()
  - pixDeskew                    → our _staff_guided_deskew()
  - fixPerspective               → our _perspective_correct()

Uses OpenCV when available (best quality), falls back to PIL + numpy.
"""

import os
import sys
import numpy as np

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

# Optimal range for Audiveris (~300 DPI on A4)
MIN_LONG_EDGE = 2400
MAX_LONG_EDGE = 3500


def log(msg):
    print(f"  [preprocess] {msg}", flush=True)


def preprocess(input_path: str, output_path: str = None, target: int = 2400) -> str:
    """
    Full preprocessing pipeline.  Returns path to cleaned image.
    Skips heavy processing if image is already clean (binary/b&w scan).
    Picks the best available backend automatically.
    """
    if output_path is None:
        base = input_path.rsplit(".", 1)[0]
        output_path = f"{base}_preprocessed.png"

    # Check whether the image is already a clean binary/b&w scan.
    # If so, just resize — don't re-binarize (would destroy thin lines).
    if _is_already_clean(input_path):
        log("Image is already clean binary — resize only")
        return _resize_only(input_path, output_path, target)

    if HAS_CV2:
        return _cv2_pipeline(input_path, output_path, target)
    return _pil_pipeline(input_path, output_path, target)


def _is_already_clean(path: str) -> bool:
    """
    Detect if the image is already a clean binary/b&w document
    (e.g., a scan, Adobe Scan output, or a rendered overlay).

    Heuristics:
      1. 1-bit images → always clean
      2. >90% pixels near-black/white → clean (perfect binary)
      3. >70% pixels near-black/white AND <10% in the gray
         midrange (80–180) → clean (Adobe Scan style, slightly noisy)
    """
    try:
        from PIL import Image as PILImage
        img = PILImage.open(path)
        mode = img.mode

        # 1-bit images are already binary by definition
        if mode == "1":
            log(f"Detected 1-bit image")
            return True

        gray = img.convert("L")
        arr = np.array(gray, dtype=np.uint8)
        total = arr.size
        near_black = np.sum(arr < 40)
        near_white = np.sum(arr > 215)
        midrange = np.sum((arr >= 80) & (arr <= 180))
        bw_ratio = (near_black + near_white) / total
        mid_ratio = midrange / total

        log(f"B&W ratio: {bw_ratio:.2%}  (black={near_black/total:.1%}, white={near_white/total:.1%}, midrange={mid_ratio:.1%})")

        # Pure binary
        if bw_ratio > 0.90:
            return True
        # Mostly clean (Adobe Scan etc.) — high B&W with very little gray
        if bw_ratio > 0.70 and mid_ratio < 0.10:
            log(f"Detected as mostly-clean document (Adobe Scan style)")
            return True
        return False
    except Exception as e:
        log(f"Clean-detection failed: {e}")
        return False


def _resize_only(src: str, dst: str, target: int) -> str:
    """Just resize + convert to grayscale PNG. No binarization."""
    from PIL import Image as PILImage

    img = PILImage.open(src).convert("L")
    w, h = img.size
    long = max(w, h)

    if long < target * 0.8:
        s = target / long
        img = img.resize((int(w * s), int(h * s)), PILImage.LANCZOS)
        log(f"Upscaled {w}×{h} → {img.size[0]}×{img.size[1]}")
    elif long > MAX_LONG_EDGE:
        s = MAX_LONG_EDGE / long
        img = img.resize((int(w * s), int(h * s)), PILImage.LANCZOS)
        log(f"Downscaled {w}×{h} → {img.size[0]}×{img.size[1]}")

    img.save(dst, "PNG")
    log(f"Output {img.size[0]}×{img.size[1]} → {dst}")
    return dst


# ──────────────────────────────────────────────────────────
#  Staff detection & staff-guided preprocessing (Zemsky-inspired)
#
#  Key insight: staff lines are the most robust visual feature in any
#  photo of sheet music.  They survive blur, tilt, poor lighting, and
#  even partial occlusion.  By detecting them FIRST, we can use their
#  geometry (angle, spacing, y-positions) to guide every subsequent
#  correction — turning "blind" preprocessing into "staff-aware".
#
#  Algorithm overview (adapted from Zemsky's staffaDetect):
#    1. Horizontal projection profile on binary image
#    2. Find peaks (dark rows = staff lines)
#    3. Group peaks into 5-line staves (consistent spacing)
#    4. Compute line_height, space_height, interline
#    5. Measure staff angles via horizontal RLE segment endpoints
# ──────────────────────────────────────────────────────────

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class StaffLine:
    """A single detected staff line."""
    y: int            # row position (center of line)
    thickness: int    # line thickness in pixels
    angle: float      # angle in degrees (0 = perfectly horizontal)


@dataclass
class Staff:
    """A 5-line staff group."""
    lines: List[StaffLine]     # exactly 5 lines, top to bottom
    top: int                   # y of topmost line
    bottom: int                # y of bottommost line
    interline: float           # average distance between adjacent lines
    line_height: float         # average staff-line thickness
    space_height: float        # average gap between lines
    angle: float               # overall staff angle in degrees


def _quick_binarize(gray):
    """Fast Otsu binarization just for staff detection (not final output).

    We don't need Sauvola quality here — we just need a reasonable
    black/white split to count horizontal projections.
    """
    # Slight blur to reduce noise
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def _detect_staffs(binary) -> List[Staff]:
    """Detect staff systems via column-sliced horizontal projection.

    The problem with global horizontal projection: a tilted staff line
    spreads its ink across many rows, diluting the per-row signal.

    Solution: divide the image into narrow vertical STRIPS.  In each strip,
    even a tilted line occupies only a few rows, producing strong peaks.
    Then trace the peaks across strips to reconstruct full staff lines.

    Algorithm:
      1. Split image into ~8 vertical strips
      2. In each strip, compute horizontal projection (sum of black per row)
      3. Find peak rows in each strip (staff-line intersections)
      4. Merge peaks across strips to form full staff lines
      5. Group into 5-line staves via consistent spacing
      6. Measure angle from the left→right peak drift across strips
    """
    h, w = binary.shape[:2]

    # --- Step 1: Column-sliced horizontal projection ---
    N_STRIPS = 8
    strip_w = w // N_STRIPS
    if strip_w < 50:
        N_STRIPS = max(1, w // 50)
        strip_w = w // N_STRIPS

    # Collect peak rows from each strip
    strip_peaks = []  # list of arrays, one per strip
    for s in range(N_STRIPS):
        x0 = s * strip_w
        x1 = x0 + strip_w if s < N_STRIPS - 1 else w
        strip = binary[:, x0:x1]
        sw = x1 - x0

        # Horizontal projection in this strip
        proj = np.sum(strip == 0, axis=1).astype(np.float64)

        # Adaptive threshold: peaks must be significantly above background.
        # Use the bimodal split: staff rows have much higher projection than
        # symbol/noise rows.  The median of nonzero projections provides a
        # natural boundary — staff rows will be well above it.
        nonzero = proj[proj > 0]
        if len(nonzero) < 10:
            strip_peaks.append(np.array([], dtype=int))
            continue

        # Primary: rows above 50% of max projection in this strip
        # (staff lines dominate, so max ≈ staff-line projection)
        max_proj = nonzero.max()
        threshold = max(max_proj * 0.4, 5)  # at least 5 pixels

        peaks = np.where(proj >= threshold)[0]
        strip_peaks.append(peaks)

    # --- Step 2: Merge peaks across strips ---
    # For each strip, merge adjacent peak rows into line segments.
    # A line segment is (center_y, thickness) in that strip.
    strip_lines = []  # list of list of (center_y, thickness)
    for peaks in strip_peaks:
        if len(peaks) == 0:
            strip_lines.append([])
            continue
        segs = []
        grp_start = int(peaks[0])
        prev = int(peaks[0])
        for r in peaks[1:]:
            r = int(r)
            if r - prev > 3:
                segs.append(((grp_start + prev) // 2, prev - grp_start + 1))
                grp_start = r
            prev = r
        segs.append(((grp_start + prev) // 2, prev - grp_start + 1))
        strip_lines.append(segs)

    # --- Step 3: Use the best strip as reference, trace lines across strips ---
    best_strip = max(range(N_STRIPS), key=lambda i: len(strip_lines[i]))
    ref_segs = strip_lines[best_strip]
    if len(ref_segs) < 5:
        log(f"Staff detection: best strip has only {len(ref_segs)} segments")
        return []

    # For each reference segment, trace LEFT and RIGHT strip-by-strip.
    # This handles large tilts because we allow incremental drift per strip.
    lines: List[StaffLine] = []
    # Max drift between adjacent strips: up to 5° tilt
    max_drift_per_strip = int(strip_w * np.tan(np.radians(5))) + 5

    for center_y, thickness in ref_segs:
        trace = {best_strip: center_y}  # strip_index → y_position

        # Trace rightward
        cur_y = center_y
        for si in range(best_strip + 1, N_STRIPS):
            found = False
            for cy, _ in strip_lines[si]:
                if abs(cy - cur_y) <= max_drift_per_strip:
                    trace[si] = cy
                    cur_y = cy
                    found = True
                    break
            if not found:
                break

        # Trace leftward
        cur_y = center_y
        for si in range(best_strip - 1, -1, -1):
            found = False
            for cy, _ in strip_lines[si]:
                if abs(cy - cur_y) <= max_drift_per_strip:
                    trace[si] = cy
                    cur_y = cy
                    found = True
                    break
            if not found:
                break

        # Require matches in >= 50% of strips
        if len(trace) >= max(N_STRIPS * 0.5, 3):
            # Compute angle from leftmost to rightmost match
            sorted_trace = sorted(trace.items())
            si_l, cy_l = sorted_trace[0]
            si_r, cy_r = sorted_trace[-1]
            angle = 0.0
            if si_r > si_l:
                dx = (si_r - si_l) * strip_w
                dy = cy_r - cy_l
                angle = np.degrees(np.arctan2(dy, dx))

            lines.append(StaffLine(y=center_y, thickness=max(thickness, 1),
                                   angle=angle if abs(angle) < 10 else 0.0))

    if len(lines) < 5:
        log(f"Staff detection: only {len(lines)} validated lines (need ≥5)")
        return []

    log(f"Staff detection: {len(lines)} candidate lines")

    # Filter unreasonably thick bands
    med_thick = float(np.median([l.thickness for l in lines]))
    max_thick = max(med_thick * 3, 20)
    lines = [l for l in lines if l.thickness <= max_thick]
    if len(lines) < 5:
        log(f"Staff detection: {len(lines)} lines after thickness filter")
        return []

    # --- Step 4: Group into 5-line staves ---
    gaps = [lines[i + 1].y - lines[i].y for i in range(len(lines) - 1)]
    if not gaps:
        return []
    gap_arr = np.array(gaps, dtype=float)
    reasonable = gap_arr[(gap_arr > 3) & (gap_arr < h * 0.05)]
    if len(reasonable) < 4:
        log("Staff detection: no consistent interline spacing")
        return []
    interline_est = float(np.median(reasonable))

    staffs: List[List[StaffLine]] = []
    current_group = [lines[0]]
    for i in range(len(lines) - 1):
        gap = lines[i + 1].y - lines[i].y
        if abs(gap - interline_est) < interline_est * 0.4:
            current_group.append(lines[i + 1])
        else:
            if len(current_group) >= 5:
                staffs.append(current_group[:5])
            current_group = [lines[i + 1]]
    if len(current_group) >= 5:
        staffs.append(current_group[:5])

    if not staffs:
        log("Staff detection: no 5-line groups found")
        return []

    # --- Step 5: Build Staff objects ---
    result: List[Staff] = []
    for group in staffs:
        ys = [l.y for l in group]
        interlines = [ys[j + 1] - ys[j] for j in range(4)]
        avg_il = float(np.mean(interlines))
        avg_th = float(np.mean([l.thickness for l in group]))
        avg_angle = float(np.mean([l.angle for l in group]))
        result.append(Staff(
            lines=group, top=ys[0], bottom=ys[4],
            interline=avg_il, line_height=avg_th,
            space_height=max(avg_il - avg_th, 1), angle=avg_angle
        ))

    info = ", ".join(
        f"staff{i+1}[y={s.top}-{s.bottom} il={s.interline:.1f} θ={s.angle:+.2f}°]"
        for i, s in enumerate(result)
    )
    log(f"Staff detection: {len(result)} staves — {info}")
    return result


def _staff_guided_deskew(gray, staffs: List[Staff]):
    """Deskew using the precise angle measured from staff lines.

    Much more accurate than the generic HoughLinesP approach because
    we're measuring the actual staff lines, not random edges.
    """
    # Use the median angle across all staves
    angles = [s.angle for s in staffs if abs(s.angle) > 0.01]
    if not angles:
        log("Staff-guided deskew: staves already horizontal")
        return gray

    angle = float(np.median(angles))
    if abs(angle) < 0.1:
        log(f"Staff-guided deskew: angle {angle:+.2f}° too small, skipping")
        return gray

    h, w = gray.shape[:2]
    M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
    cos_a, sin_a = abs(M[0, 0]), abs(M[0, 1])
    nW = int(h * sin_a + w * cos_a)
    nH = int(h * cos_a + w * sin_a)
    M[0, 2] += (nW - w) / 2
    M[1, 2] += (nH - h) / 2
    rotated = cv2.warpAffine(gray, M, (nW, nH),
                             borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    log(f"Staff-guided deskew: rotated {angle:+.2f}°")
    return rotated


def _staff_guided_resize(gray, staffs: List[Staff], target: int):
    """Scale the image so interline spacing matches Audiveris's ideal range.

    Audiveris's interline detector works best when interline ≥ 16px.
    The ideal range is 18-25px.  We know the ACTUAL interline from staff
    detection, so we can scale precisely instead of guessing from image size.

    This is a huge advantage over blind resizing: a phone photo at 3000px
    might have tiny staves (interline=8) or large ones (interline=30).
    Blind resize can't tell the difference. We can.
    """
    # Average interline across all detected staves
    avg_interline = float(np.mean([s.interline for s in staffs]))
    h, w = gray.shape[:2]

    # Target interline: 20px is Audiveris's sweet spot
    IDEAL_INTERLINE = 20.0
    MIN_INTERLINE = 16.0

    if avg_interline < 1:
        log("Staff-guided resize: invalid interline, falling back to blind resize")
        return _resize(gray, target)

    if avg_interline >= MIN_INTERLINE and avg_interline <= IDEAL_INTERLINE * 1.5:
        # Already in good range — check if image size also OK
        if min(w, h) >= 1600 and max(w, h) <= MAX_LONG_EDGE:
            log(f"Staff-guided resize: interline={avg_interline:.1f}px already ideal, no resize needed")
            return gray

    # Scale to hit ideal interline
    scale = IDEAL_INTERLINE / avg_interline

    # Safety clamps: don't blow up or shrink too much
    new_long = max(w, h) * scale
    new_short = min(w, h) * scale

    if new_long > MAX_LONG_EDGE:
        scale = MAX_LONG_EDGE / max(w, h)
    if new_short < 1200:
        scale = max(scale, 1200.0 / min(w, h))

    if abs(scale - 1.0) < 0.05:
        log(f"Staff-guided resize: scale={scale:.3f} ~1.0, skipping")
        return gray

    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    resized = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=interp)
    new_interline = avg_interline * scale
    log(f"Staff-guided resize: interline {avg_interline:.1f}→{new_interline:.1f}px "
        f"(scale={scale:.2f}, {w}×{h}→{resized.shape[1]}×{resized.shape[0]})")
    return resized


def _staff_aware_noise_removal(binary, staffs: List[Staff], min_area=10):
    """Staff-aware noise removal: keep components near staves, aggressively remove distant ones.

    Zemsky insight: real music symbols are always near a staff.
    Components far from any staff are almost certainly noise (dust, texture,
    compression artifacts, background speckles).

    Strategy:
      - Near a staff (within 2× staff height): standard noise filter (min_area)
      - Far from all staves: aggressive noise filter (much larger min_area)
    """
    h, w = binary.shape[:2]

    # Build a distance map: for each row, how far is it from the nearest staff?
    # Staff zone = from staff.top - margin to staff.bottom + margin
    if not staffs:
        return _remove_noise(binary, min_area)

    # Compute margin as 2× average staff height (generous zone for symbols)
    avg_staff_height = float(np.mean([s.bottom - s.top for s in staffs]))
    margin = int(avg_staff_height * 2)

    # Create mask of "near staff" rows
    near_staff = np.zeros(h, dtype=bool)
    for s in staffs:
        y_start = max(0, s.top - margin)
        y_end = min(h, s.bottom + margin)
        near_staff[y_start:y_end] = True

    # Process connected components
    inv = cv2.bitwise_not(binary)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(inv, connectivity=8)
    clean = np.full_like(binary, 255)

    removed_noise = 0
    removed_distant = 0

    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        c_y = int(centroids[i][1])
        cw = stats[i, cv2.CC_STAT_WIDTH]
        ch = stats[i, cv2.CC_STAT_HEIGHT]

        is_near = 0 <= c_y < h and near_staff[c_y]

        if is_near:
            # Standard filter: keep if big enough and not a single pixel
            if area >= min_area and (cw > 2 or ch > 2):
                clean[labels == i] = 0
            else:
                removed_noise += 1
        else:
            # Aggressive filter for distant components:
            # Must be much larger to survive (likely a page number, title, etc.)
            min_distant_area = max(min_area * 10, 100)
            if area >= min_distant_area and cw > 3 and ch > 3:
                clean[labels == i] = 0
            else:
                removed_distant += 1

    if removed_noise or removed_distant:
        log(f"Staff-aware noise: removed {removed_noise} near-staff specks, "
            f"{removed_distant} distant specks")
    return clean


# ──────────────────────────────────────────────────────────
#  OpenCV pipeline  (staff-aware two-stage architecture)
# ──────────────────────────────────────────────────────────

def _cv2_pipeline(src: str, dst: str, target: int) -> str:
    """Camera-photo → clean B&W pipeline optimised for music notation.

    TWO-STAGE ARCHITECTURE (Zemsky-inspired):
      Stage A — Quick pre-clean + staff detection
        Get staff lines as early as possible so we can use their geometry
        (angle, spacing, position) to guide every subsequent correction.
      Stage B — Staff-guided corrections + final binarization
        Deskew, perspective, scale, noise all use staff geometry.

    The key insight: staff lines are the most robust feature in any photo.
    Even blurry, tilted, poorly-lit shots still show horizontal lines.
    By detecting them first, we use them as a "skeleton" to fix everything.
    """
    img = cv2.imread(src)
    if img is None:
        log(f"Cannot read {src}, returning as-is")
        return src

    h, w = img.shape[:2]
    log(f"Input {w}×{h}  mode={'color' if len(img.shape)==3 else 'gray'}")

    # ── Stage A: Quick pre-clean + staff detection ─────────────

    # A1. Auto-crop — remove non-page border (table, desk, background)
    img = _auto_crop(img)

    # A2. Perspective correction (straighten tilted shots)
    img = _perspective_correct(img)

    # A3. Grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img

    # A4. Dewarp — straighten curved/bent pages
    gray = _dewarp(gray)

    # A5. Quick binarize just for staff detection (not the final output)
    quick_bin = _quick_binarize(gray)

    # A6. ★ STAFF DETECTION — the key Zemsky insight ★
    #     Detect staff lines via horizontal RLE projection.
    #     Returns staff geometry: line positions, angles, spacing.
    staffs = _detect_staffs(quick_bin)

    # ── Stage B: Staff-guided corrections ──────────────────────

    # B1. Staff-guided deskew (use actual staff angles, not Hough guessing)
    if staffs:
        gray = _staff_guided_deskew(gray, staffs)
        # Re-detect staffs after rotation (positions shifted)
        quick_bin = _quick_binarize(gray)
        staffs = _detect_staffs(quick_bin)
    else:
        gray = _deskew(gray)

    # B2. Staff-guided resize — normalize so interline = ideal pixels
    if staffs:
        gray = _staff_guided_resize(gray, staffs, target)
    else:
        gray = _resize(gray, target)

    # B3. Sharpen — phone photos are always slightly soft
    gray = _sharpen(gray)

    # B4. Final Sauvola binarization (the real one, on the corrected image)
    binary = _smart_binarize(gray)

    # B5. Morphological close to reconnect broken staff lines
    binary = _close_gaps(binary)

    # B6. Staff-aware noise removal
    if staffs:
        # Re-detect on final binary (positions changed after resize)
        staffs_final = _detect_staffs(binary)
        if staffs_final:
            binary = _staff_aware_noise_removal(binary, staffs_final)
        else:
            binary = _remove_noise(binary)
    else:
        binary = _remove_noise(binary)

    cv2.imwrite(dst, binary)
    fh, fw = binary.shape[:2]
    log(f"Output {fw}×{fh} → {dst}")
    return dst


# ──────────────────────────────────────────────────────────
#  Dewarping — straighten curved / bent pages
# ──────────────────────────────────────────────────────────

def _dewarp(gray):
    """
    Detect and correct page curvature (e.g. book spines, curled paper).

    Approach inspired by Leptonica's dewarpBuildPageModel:
      1. Binary threshold to isolate ink
      2. Find long horizontal runs (staff lines / text baselines)
      3. For each row-band, fit the horizontal center-of-mass to a polynomial
      4. Build a pixel displacement map from the curvature model
      5. Remap the grayscale image to flatten the curves

    If the page is already flat (<2px curvature), skip dewarping to avoid
    introducing artifacts on clean scans.
    """
    h, w = gray.shape[:2]

    # Need a reasonable image size for reliable detection
    if h < 400 or w < 400:
        return gray

    try:
        # --- Step 1: Rough binarization for line detection ---
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        _, bw = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        # --- Step 2: Find approximate staff-line y-positions via row sums ---
        # We use the raw binarized image (not morph-filtered) because curved
        # lines don't survive horizontal morphological opening — which is
        # exactly when dewarping is needed.  Curved lines create broad but
        # distinct peaks in the horizontal projection.
        num_bands = 40
        band_w = w // num_bands

        row_sums = np.sum(bw, axis=1).astype(np.float64)
        if row_sums.max() == 0:
            log("Dewarp: no ink found — skipping")
            return gray

        # Smooth to merge nearby staff-line peaks into one broad peak per line
        kernel_h = max(h // 80, 5)
        if kernel_h % 2 == 0:
            kernel_h += 1
        smooth = cv2.GaussianBlur(row_sums.reshape(-1, 1), (1, kernel_h), 0).flatten()

        # Adaptive threshold: peaks above 20% of max
        threshold = smooth.max() * 0.20
        peak_rows = []
        in_peak = False
        peak_start = 0
        for y in range(len(smooth)):
            if smooth[y] > threshold and not in_peak:
                in_peak = True
                peak_start = y
            elif (smooth[y] <= threshold or y == len(smooth) - 1) and in_peak:
                in_peak = False
                # Use weighted centroid within the peak for more accuracy
                seg = smooth[peak_start:y]
                if seg.sum() > 0:
                    yy = np.arange(len(seg), dtype=np.float64)
                    center = int(np.dot(yy, seg) / seg.sum()) + peak_start
                else:
                    center = (peak_start + y) // 2
                peak_rows.append(center)

        if len(peak_rows) < 3:
            log(f"Dewarp: only {len(peak_rows)} line rows found — skipping")
            return gray

        # --- Step 3: Trace curvature for each peak ---
        # In each vertical band, find the y-centroid of ink in a window
        # around the approximate peak position.  This tracks the actual
        # curve of each staff line even when it deviates 30+ px.
        win_h = max(h // 20, 20)  # generous search window
        curves = []
        for py in peak_rows:
            y_lo = max(0, py - win_h)
            y_hi = min(h, py + win_h)
            strip = bw[y_lo:y_hi, :]

            xs = []
            ys = []
            for bx in range(num_bands):
                x0 = bx * band_w
                x1 = min(x0 + band_w, w)
                col_sum = np.sum(strip[:, x0:x1], axis=1).astype(np.float64)
                if col_sum.max() < 255 * 2:
                    continue
                yy = np.arange(strip.shape[0], dtype=np.float64)
                total = col_sum.sum()
                if total < 1:
                    continue
                cy = np.dot(yy, col_sum) / total + y_lo
                cx = (x0 + x1) / 2.0
                xs.append(cx)
                ys.append(cy)

            if len(xs) >= num_bands // 3:  # need at least 1/3 of bands
                curves.append((np.array(xs), np.array(ys)))

        if len(curves) < 2:
            log(f"Dewarp: only {len(curves)} traceable curves — skipping")
            return gray

        # --- Step 4: Measure curvature (deviation from straight line) ---
        # Don't assume any polynomial shape — measure raw residuals from the
        # linear best-fit, which works for parabolic, sinusoidal, or any shape.
        max_deviation = 0.0
        residual_curves = []  # (xs, residuals) for building displacement map
        for xs, ys in curves:
            if len(xs) < 4:
                continue
            lin_coeffs = np.polyfit(xs, ys, 1)
            lin_ys = np.polyval(lin_coeffs, xs)
            residuals = ys - lin_ys  # positive = below baseline
            deviation = np.max(np.abs(residuals))
            max_deviation = max(max_deviation, deviation)
            residual_curves.append((xs, residuals))

        log(f"Dewarp: {len(curves)} curves traced, max curvature = {max_deviation:.1f}px")

        if max_deviation < 2.0:
            log("Dewarp: page is flat enough — skipping")
            return gray

        if not residual_curves:
            return gray

        # --- Step 5: Build displacement map from traced residuals ---
        # Average the residual curves to get a single curvature profile.
        # Interpolate to get a smooth displacement value for every x pixel.
        x_coords = np.arange(w, dtype=np.float64)

        # Resample each residual curve onto a common grid, then average
        resampled = []
        for xs, res in residual_curves:
            # Interpolate this curve's residuals to every pixel column
            interp = np.interp(x_coords, xs, res, left=res[0], right=res[-1])
            resampled.append(interp)

        # Average across all curves — curvature shape should be consistent
        avg_displacement = np.mean(resampled, axis=0)

        # Smooth the displacement to avoid pixel-level noise
        kernel_sm = max(w // 50, 5)
        if kernel_sm % 2 == 0:
            kernel_sm += 1
        avg_displacement = cv2.GaussianBlur(
            avg_displacement.reshape(1, -1).astype(np.float32),
            (kernel_sm, 1), 0
        ).flatten()

        # Build full remap arrays
        map_x = np.zeros((h, w), dtype=np.float32)
        map_y = np.zeros((h, w), dtype=np.float32)

        for y in range(h):
            map_x[y, :] = x_coords.astype(np.float32)
            map_y[y, :] = (y - avg_displacement).astype(np.float32)

        # --- Step 6: Remap ---
        dewarped = cv2.remap(gray, map_x, map_y,
                             interpolation=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT,
                             borderValue=255)

        log(f"Dewarp: applied correction (max shift = {max_deviation:.1f}px)")
        return dewarped

    except Exception as e:
        log(f"Dewarp: failed ({e}) — skipping")
        return gray


# ──────────────────────────────────────────────────────────
#  PIL / numpy fallback pipeline
# ──────────────────────────────────────────────────────────

def _pil_pipeline(src: str, dst: str, target: int) -> str:
    from PIL import Image, ImageFilter, ImageOps

    img = Image.open(src)
    w, h = img.size
    log(f"Input {w}×{h}  mode={img.mode}  (PIL pipeline)")

    # Grayscale
    gray = img.convert("L")

    # Resize — ensure short edge ≥ 1600 for adequate interline spacing
    long = max(w, h)
    short = min(w, h)
    MIN_SHORT = 1600
    if short < MIN_SHORT:
        s = MIN_SHORT / short
        gray = gray.resize((int(w * s), int(h * s)), Image.LANCZOS)
        log(f"Upscaled (short edge) → {gray.size[0]}×{gray.size[1]}")
    elif long < target * 0.8:
        s = target / long
        gray = gray.resize((int(w * s), int(h * s)), Image.LANCZOS)
        log(f"Upscaled → {gray.size[0]}×{gray.size[1]}")
    elif long > MAX_LONG_EDGE:
        s = MAX_LONG_EDGE / long
        if short * s < MIN_SHORT:
            s = MIN_SHORT / short
        gray = gray.resize((int(w * s), int(h * s)), Image.LANCZOS)
        log(f"Downscaled → {gray.size[0]}×{gray.size[1]}")

    # Auto-contrast
    gray = ImageOps.autocontrast(gray, cutoff=1)

    # Sauvola via numpy (same maths as CV2 version, just slower)
    arr = np.array(gray, dtype=np.float64)
    bw, bh = gray.size
    win = max(bw, bh) // 40          # window ≈ 1/40th of image
    if win % 2 == 0:
        win += 1
    win = max(win, 11)

    # local mean via box blur
    blurred = gray.filter(ImageFilter.BoxBlur(win // 2))
    mean = np.array(blurred, dtype=np.float64)

    # local std approximation  (|pixel − mean|  blurred)
    diff_img = Image.fromarray(np.abs(arr - mean).astype(np.uint8))
    std_approx = np.array(diff_img.filter(ImageFilter.BoxBlur(win // 2)),
                          dtype=np.float64) + 1e-6

    R = 128.0
    k = 0.2
    thresh = mean * (1.0 + k * (std_approx / R - 1.0))
    binary = np.where(arr > thresh, 255, 0).astype(np.uint8)
    log(f"Sauvola binarised (PIL)  win={win}  k={k}")

    result = Image.fromarray(binary, mode="L")
    result.save(dst, "PNG")
    log(f"Output {result.size[0]}×{result.size[1]} → {dst}")
    return dst


# ──────────────────────────────────────────────────────────
#  Shared helpers (OpenCV)
# ──────────────────────────────────────────────────────────

def _auto_crop(img):
    """Remove non-page border (table, desk, dark background).

    Uses edge detection + largest-contour bounding rect to find the
    sheet music page, even without a perfect 4-corner quad.  More
    lenient than perspective_correct — works on partial page edges.
    """
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    # Detect page area using Otsu on the grayscale
    blurred = cv2.GaussianBlur(gray, (11, 11), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Find the largest bright region (= the page)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img

    largest = max(contours, key=cv2.contourArea)
    area_ratio = cv2.contourArea(largest) / (w * h)

    # Only crop if the page fills 20–90% of the frame (if ~100%, no background to remove)
    if area_ratio < 0.20 or area_ratio > 0.92:
        return img

    x, y, rw, rh = cv2.boundingRect(largest)
    # Add small margin (2%)
    margin_x = int(rw * 0.02)
    margin_y = int(rh * 0.02)
    x1 = max(0, x - margin_x)
    y1 = max(0, y - margin_y)
    x2 = min(w, x + rw + margin_x)
    y2 = min(h, y + rh + margin_y)

    if (x2 - x1) < w * 0.5 or (y2 - y1) < h * 0.5:
        return img  # crop too aggressive, skip

    cropped = img[y1:y2, x1:x2]
    log(f"Auto-cropped {w}×{h} → {x2-x1}×{y2-y1}  (page fills {area_ratio:.0%})")
    return cropped


def _perspective_correct(img):
    """Detect page quad and warp to a flat rectangle."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
                       iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img

    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.contourArea(approx) > w * h * 0.25:
            pts = _order_quad(approx.reshape(4, 2).astype(np.float32))
            wA = np.linalg.norm(pts[2] - pts[3])
            wB = np.linalg.norm(pts[1] - pts[0])
            hA = np.linalg.norm(pts[1] - pts[2])
            hB = np.linalg.norm(pts[0] - pts[3])
            maxW, maxH = int(max(wA, wB)), int(max(hA, hB))
            if maxW < 200 or maxH < 200:
                continue
            dst = np.array([[0, 0], [maxW - 1, 0],
                            [maxW - 1, maxH - 1], [0, maxH - 1]], dtype=np.float32)
            M = cv2.getPerspectiveTransform(pts, dst)
            warped = cv2.warpPerspective(img, M, (maxW, maxH))
            log(f"Perspective corrected {w}×{h} → {maxW}×{maxH}")
            return warped

    return img


def _order_quad(pts):
    """Order 4 points: TL, TR, BR, BL."""
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    rect[1] = pts[np.argmin(d)]
    rect[3] = pts[np.argmax(d)]
    return rect


def _deskew(gray):
    """Rotate so staff lines are perfectly horizontal."""
    h, w = gray.shape[:2]
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100,
                            minLineLength=int(w * 0.3), maxLineGap=20)
    if lines is None or len(lines) < 3:
        return gray

    angles = []
    for l in lines:
        x1, y1, x2, y2 = l[0]
        a = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(a) < 10:
            angles.append(a)

    if not angles:
        return gray
    med = float(np.median(angles))
    if abs(med) < 0.1:
        return gray

    M = cv2.getRotationMatrix2D((w // 2, h // 2), med, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nW, nH = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += (nW - w) / 2
    M[1, 2] += (nH - h) / 2
    rotated = cv2.warpAffine(gray, M, (nW, nH),
                             borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    log(f"Deskewed {med:+.2f}°")
    return rotated


def _resize(gray, target):
    """
    Scale so both edges are large enough for Audiveris.
    Audiveris needs interline ≥ 16px, which requires the short edge
    (where staves run) to be at least ~1600px for typical sheet music.
    """
    h, w = gray.shape[:2]
    long_edge = max(w, h)
    short_edge = min(w, h)
    MIN_SHORT_EDGE = 1600  # guarantee enough interline pixels

    if short_edge < MIN_SHORT_EDGE:
        # Short edge is too small — scale based on short edge
        s = MIN_SHORT_EDGE / short_edge
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        log(f"Upscaled (short edge) {w}×{h} → {gray.shape[1]}×{gray.shape[0]}")
    elif long_edge < target * 0.8:
        # Long edge is too small
        s = target / long_edge
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        log(f"Upscaled (long edge) {w} → {gray.shape[1]}px")
    elif long_edge > MAX_LONG_EDGE:
        # Too large — but don't shrink short edge below minimum
        s = MAX_LONG_EDGE / long_edge
        if short_edge * s < MIN_SHORT_EDGE:
            s = MIN_SHORT_EDGE / short_edge
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        log(f"Downscaled {w}×{h} → {gray.shape[1]}×{gray.shape[0]}")
    return gray


def _sharpen(gray):
    """Unsharp-mask sharpening to recover phone-camera softness.

    Phone photos are always slightly soft due to small sensor, thin lens,
    and possible slight motion blur.  Without sharpening, 1-2px staff lines
    become gray blobs that Sauvola binarization turns into broken dashes.

    Uses a mild unsharp mask:  sharpened = gray + alpha * (gray - blurred)
    Alpha is adaptive — computed from the image's own blur level.
    """
    h, w = gray.shape[:2]

    # Measure blur level via Laplacian variance
    lap_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    if lap_var > 800:
        # Image is already sharp (scanned document) — skip
        log(f"Sharpen: skipped (Laplacian variance = {lap_var:.0f}, already sharp)")
        return gray

    # Adaptive strength: blurrier images get more sharpening
    if lap_var < 100:
        alpha = 1.5  # very blurry
    elif lap_var < 300:
        alpha = 1.0  # moderately soft
    else:
        alpha = 0.5  # mildly soft

    # Gaussian blur radius scales with image size (~1/400 of long edge)
    sigma = max(w, h) / 400.0
    sigma = max(1.0, min(sigma, 3.0))

    blurred = cv2.GaussianBlur(gray, (0, 0), sigma)
    sharpened = cv2.addWeighted(gray, 1.0 + alpha, blurred, -alpha, 0)
    sharpened = np.clip(sharpened, 0, 255).astype(np.uint8)

    log(f"Sharpened: alpha={alpha:.1f}  sigma={sigma:.1f}  (blur score={lap_var:.0f})")
    return sharpened


def _smart_binarize(gray):
    """Intelligent binarization: Sauvola first (like Zemsky/Leptonica),
    with Adobe-Scan fallback for difficult lighting conditions.

    Sauvola is the gold standard for document binarization — it preserves
    thin lines (staff lines, stems) far better than global approaches.
    But it can struggle with extreme lighting gradients (shadow across page).
    In that case, fall back to the multi-pass Adobe-Scan approach.
    """
    h, w = gray.shape[:2]

    # Try Sauvola first
    binary = _sauvola(gray, k=0.15)  # k=0.15 slightly less aggressive than default

    # Validate result: check ink coverage
    total = binary.size
    black = np.sum(binary < 128)
    ink_pct = black / total

    if 0.02 <= ink_pct <= 0.35:
        # Looks reasonable for sheet music (2-35% ink)
        log(f"Smart binarize: Sauvola succeeded (ink={ink_pct:.1%})")
        return binary

    # Sauvola failed — too little or too much ink.
    # The image likely has extreme lighting issues.  Fall back to Adobe-Scan.
    log(f"Smart binarize: Sauvola ink={ink_pct:.1%} (bad) — trying Adobe-Scan fallback")
    fallback = _adobe_scan_binarize(gray)

    fb_ink = np.sum(fallback < 128) / total
    if 0.02 <= fb_ink <= 0.35:
        log(f"Smart binarize: Adobe-Scan fallback succeeded (ink={fb_ink:.1%})")
        return fallback

    # Both failed — return whichever has more plausible coverage
    if abs(ink_pct - 0.10) < abs(fb_ink - 0.10):
        log(f"Smart binarize: both marginal, keeping Sauvola (ink={ink_pct:.1%})")
        return binary
    else:
        log(f"Smart binarize: both marginal, keeping Adobe-Scan (ink={fb_ink:.1%})")
        return fallback


def _sauvola(gray, win=0, k=0.2, R=128.0):
    """
    Sauvola adaptive binarisation — gold standard for documents.
    T(x,y) = mean(x,y) * (1 + k * (std(x,y)/R − 1))
    Uses integral images so it's fast even on large images.
    """
    h, w = gray.shape[:2]
    if win == 0:
        win = max(w, h) // 40
        if win % 2 == 0:
            win += 1
        win = max(win, 11)

    gf = gray.astype(np.float64)
    pad = win // 2

    integral   = cv2.integral(gf)          # shape (h+1, w+1)
    integral_sq = cv2.integral(gf * gf)

    # vectorised local-sum via integral images
    y1 = np.clip(np.arange(h) - pad, 0, h).astype(int)
    y2 = np.clip(np.arange(h) + pad + 1, 0, h).astype(int)
    x1 = np.clip(np.arange(w) - pad, 0, w).astype(int)
    x2 = np.clip(np.arange(w) + pad + 1, 0, w).astype(int)

    Y1, X1 = np.meshgrid(y1, x1, indexing="ij")
    Y2, X2 = np.meshgrid(y2, x2, indexing="ij")
    cnt = np.maximum((Y2 - Y1) * (X2 - X1), 1)

    sm  = integral[Y2, X2] - integral[Y1, X2] - integral[Y2, X1] + integral[Y1, X1]
    ssq = integral_sq[Y2, X2] - integral_sq[Y1, X2] - integral_sq[Y2, X1] + integral_sq[Y1, X1]

    mean = sm / cnt
    std  = np.sqrt(np.maximum(ssq / cnt - mean * mean, 0))

    thresh = mean * (1.0 + k * (std / R - 1.0))
    out = np.where(gf > thresh, 255, 0).astype(np.uint8)
    log(f"Sauvola binarised  win={win}  k={k}")
    return out


def _adobe_scan_binarize(gray):
    """Adobe-Scan-style aggressive binarization.

    Multi-pass approach that forces a clean pure-black-on-white result
    from any camera photo, regardless of lighting conditions:

    1. Strong bilateral filter — smooths texture/noise but keeps edges (ink)
    2. Background estimation via large morphological open — models the page
    3. Divide gray by background — eliminates all lighting gradients
    4. CLAHE on the flattened image — maximize local contrast
    5. Aggressive adaptive threshold — pure B&W output
    6. Otsu validation fallback
    """
    h, w = gray.shape[:2]
    log(f"Adobe-Scan binarization on {w}×{h}")

    # --- Step 1: Bilateral filter (denoise while preserving edges) ---
    smooth = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)

    # --- Step 2: Estimate background via large morphological opening ---
    # Kernel large enough to "erase" staff lines and notes, leaving only
    # the page background + lighting gradient
    bg_kernel_size = max(w, h) // 15
    if bg_kernel_size % 2 == 0:
        bg_kernel_size += 1
    bg_kernel_size = max(bg_kernel_size, 51)
    bg_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                          (bg_kernel_size, bg_kernel_size))
    background = cv2.morphologyEx(smooth, cv2.MORPH_OPEN, bg_kernel)
    log(f"Background estimated  kernel={bg_kernel_size}")

    # --- Step 3: Divide — cancel lighting gradients ---
    # result = (gray / background) * 255  — makes page uniformly white
    bg_float = background.astype(np.float64)
    bg_float[bg_float < 1] = 1  # avoid division by zero
    flat = (smooth.astype(np.float64) / bg_float * 255.0)
    flat = np.clip(flat, 0, 255).astype(np.uint8)
    log(f"Background divided — lighting flattened")

    # --- Step 4: CLAHE on the flattened image ---
    tile = max(4, min(w, h) // 20)
    clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(tile, tile))
    enhanced = clahe.apply(flat)
    log(f"CLAHE enhanced  tile={tile}  clip=4.0")

    # --- Step 5: Aggressive adaptive threshold ---
    # Block size ~1/30th of image — responds to local detail
    block = max(w, h) // 30
    if block % 2 == 0:
        block += 1
    block = max(block, 15)
    # C=12 is aggressive — biases toward black, ensuring staff lines survive
    binary = cv2.adaptiveThreshold(enhanced, 255,
                                   cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, block, 12)
    log(f"Adaptive threshold  block={block}  C=12")

    # --- Step 6: Validate ink coverage ---
    total = binary.size
    black = np.sum(binary < 128)
    ink_pct = black / total
    log(f"Ink coverage: {ink_pct:.1%}")

    if ink_pct < 0.02:
        # Threshold was too conservative — try Otsu on the enhanced image
        log(f"Too little ink — Otsu fallback")
        _, binary = cv2.threshold(enhanced, 0, 255,
                                  cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        ink_pct2 = np.sum(binary < 128) / total
        log(f"Otsu ink coverage: {ink_pct2:.1%}")
    elif ink_pct > 0.40:
        # Too much ink (image was very dark) — lighten the threshold
        log(f"Too much ink — retrying with C=20")
        binary = cv2.adaptiveThreshold(enhanced, 255,
                                       cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY, block, 20)
        ink_pct2 = np.sum(binary < 128) / total
        log(f"Adjusted ink coverage: {ink_pct2:.1%}")

    return binary


def _close_gaps(binary):
    """Morphological close to reconnect small gaps in staff lines,
    then open to thin bloated lines back to a consistent width."""
    # Close: bridge tiny horizontal gaps
    close_k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 1))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_k)
    # Open: thin any bloated vertical strokes (prevents line(1,11,13) issue)
    open_k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 2))
    thinned = cv2.morphologyEx(closed, cv2.MORPH_OPEN, open_k)
    return thinned
    return closed


def _remove_noise(binary, min_area=10):
    """Remove small connected-component specks (salt/pepper, dust)."""
    inv = cv2.bitwise_not(binary)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=8)
    clean = np.full_like(binary, 255)
    removed = 0
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        cw   = stats[i, cv2.CC_STAT_WIDTH]
        ch   = stats[i, cv2.CC_STAT_HEIGHT]
        if area >= min_area and (cw > 2 or ch > 2):
            clean[labels == i] = 0
        else:
            removed += 1
    if removed:
        log(f"Noise removal: dropped {removed} tiny components")
    return clean


# ──────────────────────────────────────────────────────────
#  CLI for standalone testing
# ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <input> [output]")
        sys.exit(1)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    out = preprocess(src, dst)
    print(f"Done → {out}")
