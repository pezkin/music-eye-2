# Zemsky Sheet Music Scanner — Complete Reverse Engineering

> Deep analysis of `libsource-lib.so` (3.3MB, arm64) from David Zemsky's
> *Sheet Music Scanner v4.x* APK (`com.xemsoft.sheetmusicscanner2`).

---

## 1. Architecture Overview

The engine is a **pure C library** with JNI wrappers, using:

| Component | Library | Size | Purpose |
|---|---|---|---|
| Core engine | `libsource-lib.so` | 3.3 MB | All OMR logic |
| Image processing | `liblept.so` (Leptonica) | 2.2 MB | Binarization, morphology, correlation |
| CNN inference | fdeep (embedded in libsource-lib) | ~300 KB | Time signature & character OCR |
| Linear algebra | Eigen (embedded) | — | Matrix ops for fdeep |
| MP3 export | `liblame.so` | 243 KB | Audio encoding |
| JPEG I/O | `libjpgt.so` | 238 KB | Image I/O |
| PNG I/O | `libpngt.so` | 214 KB | Image I/O |

**Total native: ~6.2 MB** (vs our Audiveris at ~137 MB)

---

## 2. Complete Recognition Pipeline

The engine executes the following stages, orchestrated from Java via JNI:

```
┌─────────────────────────────────────────────────────────┐
│  INPUT: Camera photo (JPEG/PNG via Leptonica)           │
├─────────────────────────────────────────────────────────┤
│  1. PREPROCESSING                                       │
│     fixPerspective()  ── vanishing point correction     │
│     preprocess()      ── adaptive binarization          │
│     preprocess0()     ── alternative preprocessing      │
│     binarize()        ── pixSauvolaBinarize             │
├─────────────────────────────────────────────────────────┤
│  2. STAFF DETECTION                                     │
│     staffaDetect()    ── find staff groups               │
│     findStaffLines()  ── locate individual lines         │
│     staffRemoveWithScan() ── erase staff lines          │
├─────────────────────────────────────────────────────────┤
│  3. TEMPLATE LOADING                                    │
│     loadTemplatesByStaffHeight() ── scale templates     │
│     templateDicCreate/Add/Get    ── template dictionary │
│     templaLoad()      ── load template array            │
├─────────────────────────────────────────────────────────┤
│  4. PRIMITIVE DETECTION                                 │
│     findPrimitives()  ── connected component analysis   │
│     findCorrelationScoreInBB() ── template matching     │
│     findCorrelationScoreInBBBlack() ── variant          │
│     isPrimByTemplate() ── template confirmation          │
├─────────────────────────────────────────────────────────┤
│  5. SYMBOL RECOGNITION                                  │
│     recognizeInitialClef()     ── first clef per staff  │
│     recognizeClefChanges()     ── mid-line clef changes │
│     recognizeBarlines()        ── bar detection         │
│     recognizeKeySignature()    ── sharps/flats          │
│     recognizeTimeSignatures()  ── time sig (CNN+templ)  │
│     recognizeFullHeads()       ── filled noteheads      │
│     recognizeWholeAndHalfNoteHeads() ── hollow heads    │
│     recognizeBeams()           ── beam groups           │
│     recognizeRectRests()       ── rectangular rests     │
│     recognizeShortRests()      ── 8th/16th/32nd rests   │
│     recognizeStemDuration()    ── stem-based duration    │
│     recognizeStemlessNotes()   ── stemless mode         │
│     recognizeNoteLengths()     ── final duration assign │
│     recognizeRepeatEndings()   ── repeat brackets       │
│     recognizeTuplets()         ── tuplet brackets       │
│     findDurationDots()         ── dots after notes      │
│     findStaccatoDots()         ── articulation dots     │
├─────────────────────────────────────────────────────────┤
│  6. GROUPING & VOICE ASSIGNMENT                         │
│     findGroups()               ── beam grouping         │
│     assembleBeamGroups()       ── beam→note association │
│     scoreCalculateVoiceIndexes() ── voice separation    │
│     scoreAssignVoiceIndexesToSounds() ── voice assign   │
│     scoreIsMultipleVoices()    ── multi-voice detect    │
│     scoreFindAndInterpretTies() ── tie interpretation   │
├─────────────────────────────────────────────────────────┤
│  7. EXPORT                                              │
│     exportToMusicXml()         ── MusicXML generation   │
│     exportToMusicXml2()        ── variant export        │
│     exportToMusicXml_v3()      ── v3 format             │
│     serialize/deserialize()    ── session persistence   │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Symbol Type Enums

### 3.1 Primitive Types (kP* — raw detected primitives)

Ordered by memory address (= enum value order):

| Enum | Name | Description |
|---|---|---|
| kPNotIdentified | Not identified | Unrecognized primitive |
| kPClefTreble | Treble clef | G clef |
| kPClefBass | Bass clef | F clef |
| kPClefAlto | Alto clef | C clef (alto/tenor) |
| kPTimeSignature | Time signature | Time sig container |
| kPNote4 | Quarter note | Crotchet |
| kPNoteWhole | Whole note | Semibreve |
| kPNoteHalf | Half note | Minim |
| kPNote8 | Eighth note | Quaver |
| kPNote16 | 16th note | Semiquaver |
| kPNote32 | 32nd note | Demisemiquaver |
| kPAccFlat | Flat | ♭ accidental |
| kPAccNatural | Natural | ♮ accidental |
| kPAccSharp | Sharp | ♯ accidental |
| kPRestMeasure | Measure rest | Full-bar rest |
| kPRestWhole | Whole rest | Semibreve rest |
| kPRestHalf | Half rest | Minim rest |
| kPRestCrotchet | Quarter rest | Crotchet rest |
| kPRest8 | 8th rest | Quaver rest |
| kPRest16 | 16th rest | Semiquaver rest |
| kPRest32 | 32nd rest | Demisemiquaver rest |
| kPDurationDot | Duration dot | Augmentation dot |
| kPHook8Down | 8th flag down | |
| kPHook8Up | 8th flag up | |
| kPHook16Down | 16th flag down | |
| kPHook16Up | 16th flag up | |
| kPHook32Down | 32nd flag down | |
| kPHook32Up | 32nd flag up | |
| kPNoteBeam | Beam | Connects note groups |
| kPNoteStem | Note stem | Vertical stem line |
| kPBarLine | Barline | Single barline |
| kPBarLineThick | Thick barline | Double/final barline |
| kPKeySignature | Key signature | Key sig container |

### 3.2 Symbol Types (kS* — post-recognition symbols)

| Enum | Name |
|---|---|
| kSNotIdentified | Not identified |
| kSClefTreble | Treble clef |
| kSClefBass | Bass clef |
| kSClefAlto | Alto clef |
| kSNote4 | Quarter note |
| kSNoteWhole | Whole note |
| kSNoteHalf | Half note |
| kSNote8 | 8th note |
| kSNote16 | 16th note |
| kSNote32 | 32nd note |
| kSAccFlat | Flat |
| kSAccNatural | Natural |
| kSAccSharp | Sharp |
| kSRestMeasure | Measure rest |
| kSRestWhole | Whole rest |
| kSRestHalf | Half rest |
| kSRestCrotchet | Quarter rest |
| kSRest8 | 8th rest |
| kSRest16 | 16th rest |
| kSRest32 | 32nd rest |
| kSDurationDot | Duration dot |
| kSTimeSignatureUnIdentified | TS unidentified |
| kSTimeSignatureNormal | TS normal (e.g. 4/4) |
| kSTimeSignatureCommon | TS common time (C) |
| kSTimeSignatureCut | TS cut time (₵) |

### 3.3 Additional Recognized Types (from debug strings)

- FULL HEAD, HALF NOTE, WHOLE NOTE, STEMLESS 1/2 NOTE, STEMLESS 1/4 NOTE, STEMLESS HALF NOTE
- BEAM, DOUBLE BARLINE, DOUBLE FINAL LINE
- REPEAT START, REPEAT END, REPEAT END-START, ENDING
- OCTAVE DOWN (8va/8vb), ALTO CLEF, TENOR CLEF, BASS CLEF, TREBLE CLEF
- kPRest64 (64th rest — found in debug strings)

---

## 4. Core Data Structures

### 4.1 PRIM (Primitive — detected symbol)

```c
typedef struct {
    int id;
    int recognizedType;      // kP* enum value
    BOX *box;                // bounding box (x, y, w, h)
    PIX *pix;                // binary image of the symbol
    int yIndex;              // staff line position (-2..+2 for on-line)
    int accidentalYIndex;    // pitch offset from accidental
    int refcount;
    
    // Match results
    MATCHA *matcha;          // array of template match results
    
    // Stem properties
    int isStemUp;
    int isStemDown;
    int isStemPureHalfNotes;
    int hasStemHeadsOnTheLeft;
    int hasStemHeadsOnTheRight;
    NUMA *headStemsL;        // left-side stem heads
    NUMA *headStemsR;        // right-side stem heads
    
    // Beam properties (when this PRIM is a beam)
    int beamGroupId;
    int beamHeight;
    int beamY0L, beamY0R;    // beam endpoints left/right
    NUMA *beamStemsXOri;     // original X positions of stems
    NUMA *beamTimesToNext;   // duration to next note
    NUMA *beamStaffIndexes;  // which staff each note belongs to
    NUMA *beamStartTimeRel;  // relative start times
    
    // Stem detailed properties (when this PRIM is a stem)
    int stemHeadY0, stemHeadY1;  // head Y range
    NUMA *stemBeamCountL, *stemBeamCountR;
    NUMA *stemBeamDeltasL, *stemBeamDeltasR;
    NUMA *stemBeamHookCountL, *stemBeamHookCountR;
    NUMA *stemBeamY0sL, *stemBeamY0sR;
    NUMA *stemBeamY1sL, *stemBeamY1sR;
    NUMA *stemBeamGroupIds;
    NUMA *stemBeamOrders;
} PRIM;
```

### 4.2 MATCH (Template match result)

```c
typedef struct {
    int primType;    // the kP* type that matched
    float score;     // correlation score (0.0 - 1.0)
} MATCH;
```

### 4.3 TEMPL (Template)

```c
typedef struct {
    PIX *pix;       // binary template image
    int type;       // kP* type this template represents
    int area;       // pixel area (for normalization)
    int refCount;   // reference counting
} TEMPL;
```

### 4.4 TEMPLATE_DIC (Template Dictionary)

```c
typedef struct {
    PIXAA *pixaa;   // 2D array of template images (indexed by type)
    NUMAA *areasa;  // 2D array of pixel areas
    NUMAA *typea;   // 2D array of type IDs
} TEMPLATE_DIC;
```

### 4.5 STAFF

```c
typedef struct {
    int index;             // staff index in the system
    int xOri, yOri;        // origin coordinates
    STAFFLINE *lines;      // array of 5 staff lines
    // Derived: lineHeight, spaceHeight, staffHeight computed from lines
} STAFF;
```

### 4.6 BAR (Measure)

```c
typedef struct {
    BOX *box;
    int clef;              // kP* clef type
    int isWholeRestOnly;   // true if bar has only a whole rest
    float length;          // duration in beats
    int offset;            // time offset from start
    int n, nalloc;         // timepoint count
    KEYSIGNATURE *keySignature;
    TIMESIGNATURE *timeSignature;
    TIMEPOINT **timepoints;
} BAR;
```

### 4.7 SOUND (Musical event)

```c
typedef struct {
    int id;
    BOX *box;
    PIX *pix;
    int type;                      // kS* symbol type
    int pitch;
    int pitchWithoutAccidentals;
    int accidentalType;
    float length;                  // duration in beats
    float displayLength;
    float shortLength;
    int dotCount;
    int isRest;
    int isTiedWithPrevious;
    int firstTiedNote, nextTiedNote;  // linked list for ties
    BOX *tieBox;
    PIX *tiePix;
    float lengthConfirmedByBeam;
    int headY0, headY1;
    float x0, x1;                 // horizontal extent
    int voiceIndex;
    int voiceSubindexSplit;
    float volume;
    
    // Beam info per direction (Up/Down × Left/Right)
    int beamCountUL, beamCountUR;
    int beamCountDL, beamCountDR;
    int beamHookCountUL, beamHookCountUR;
    int beamHookCountDL, beamHookCountDR;
} SOUND;
```

### 4.8 SYMBOL (Display symbol — post-recognition)

```c
typedef struct {
    BOX *box;
    PIX *pix;
    int type;                   // kS* symbol type
    int yIndex;                 // staff position
    int refcount;
    int dotCount;
    int headCenterX, headCenterY;
    int headY0, headY1;
    int headY0Ori, headY1Ori;
    int headHasStemUp, headHasStemDown;
    int headStemX0Ori, headStemX1Ori;
    int x0Ori, x1Ori;
    int isLastHeadOnStem;
    int isNoteLengthRecognized;
    int shortestStemType;
    int hasCurlyBeam;
    BOX *extendDotBox;
    PRIMA *prima;               // associated primitives
    int tsBeats, tsBeatType;    // time signature info
    NUMA *stemBeamGroupIds;
    NUMA *stemBeamOrders;
    
    // Beam info (same as sound)
    int beamCountUL, beamCountUR;
    int beamCountDL, beamCountDR;
    int beamHookCountUL, beamHookCountUR;
    int beamHookCountDL, beamHookCountDR;
} SYMBOL;
```

### 4.9 TIMEPOINT

```c
typedef struct {
    float startTime;
    float timeToNext;
    float x0, x1;
    int n, nalloc;
    SOUND **sounds;
    int doesOwnSounds;
    int isVerified;
    NUMA *beamGroupIds;
    NUMA *beamOrders;
} TIMEPOINT;
```

### 4.10 SCORE & SESSION

```c
typedef struct {
    BARAA *singleBaraa;    // bars for single-staff systems
    BARAA *groupBaraa;     // bars for grouped staves (grand staff)
    NUMA *voiceCounts;     // voice count per staff
    NUMA *voiceIndexes;    // voice index mapping
} SCORE;

typedef struct {
    SCORE **array;
    int n, nalloc;
    int serializerVersionAtCreation;
} SESSION;
```

---

## 5. Template Matching System

### 5.1 How Templates Work

Templates are **binary (1-bit) images** of canonical music symbols at various staff heights.

```
loadTemplates(path)
  └── loadTemplatesPriv()
        ├── reads .templates.png files from assets
        ├── splits into individual symbol templates
        └── creates TEMPLA (template array) and TEMPLATE_DIC

loadTemplatesByStaffHeight(staffHeight)
  └── scales templates to match detected staff spacing
      └── templaLoadByStaffHeight() 
            ├── finds or creates templates for this staffHeight
            └── caches in templateDic for reuse
```

### 5.2 Template Matching Algorithm

The core matching uses **Leptonica's `pixCorrelationScore`**:

```
findCorrelationScoreInBB(pix, templ, box)
  ├── clips the region of interest from the binarized image
  ├── calls pixCorrelationScore(pixClipped, templPix)
  │     └── counts matching black pixels / total pixels
  ├── returns score (0.0 = no match, 1.0 = perfect match)
  └── threshold: typically > 0.7 for "confirmed by template"
  
findCorrelationScoreInBBBlack(pix, templ, box)
  └── variant that only considers black (foreground) pixels

findCorrelationScoreBest(pix, templa, box)
  └── tries ALL templates, returns best match type + score
```

### 5.3 Match Process Debug Strings

```
"confirmed by template, score: %f"       ← match accepted
"template matching score: %f"            ← raw score reported
"match not found by template"            ← no template matched
"couldn't match to template (isOnLine=%i)" ← position-dependent failure
"cannot match by template"               ← template unavailable
```

---

## 6. CNN Models (fdeep / Keras)

Three small CNN models are used for character recognition:

| Model | Function | Purpose |
|---|---|---|
| `ocr_initCharModel` | Character OCR | Generic character recognition |
| `ocr_initTimeSignaturesCModel` | TS "C" recognition | Common/cut time (C, ₵) |
| `ocr_initTimeSignaturesDigitModel` | TS digit recognition | Numbers (2,3,4,6,8,12…) |

### 6.1 fdeep Layer Types Found

The fdeep framework supports these Keras layers (all found in binary):
- `input_layer`
- `conv_2d_layer`, `separable_conv_2D_layer`, `depthwise_conv_2D_layer`
- `batch_normalization_layer`
- `dense_layer`
- `flatten_layer`
- `max_pooling_2d_layer`, `average_pooling_2d_layer`
- `global_max_pooling_1d_layer`, `global_max_pooling_2d_layer`
- `global_average_pooling_1d_layer`, `global_average_pooling_2d_layer`
- `upsampling_1d_layer`, `upsampling_2d_layer`
- `relu_layer_isolated`, `leaky_relu_layer_isolated`, `elu_layer_isolated`
- `prelu_layer`
- `permute_layer`, `identity_layer`
- `add_layer`, `maximum_layer`, `concatenate_layer`
- `model_layer` (nested models)

### 6.2 Model Architecture

```c
// Constructor: FrugallyDeepModel(jsonPath, inputWidth, inputHeight)
initModel(FrugallyDeepModel **model, const char *jsonPath, int w, int h);

// Inference: takes a Leptonica PIX, returns prediction + confidence
FrugallyDeepModel::predict(PIX *pix, float &confidence);
```

The models are loaded from **JSON files** in the APK's `assets/` folder (fdeep format = Keras model exported to JSON with weights embedded).

---

## 7. Preprocessing Details

### 7.1 Perspective Correction

```c
fixPerspective(PIX *pix)
  ├── findVanishingPoint()     ── detect vanishing point from line angles
  ├── findVPLines()            ── find converging lines
  └── applies perspective warp to straighten the page
```

### 7.2 Binarization

```c
binarize(PIX *pix)
  └── binarizePriv()
        ├── pixSauvolaBinarize()        ── Sauvola local thresholding
        ├── pixOtsuAdaptiveThreshold()   ── fallback
        └── pixUnsharpMasking()          ── sharpening before binarization
```

Debug strings confirm: `"preprocessed"`, `"pixSharpened"`, `"binarize"`

### 7.3 Distortion Detection

```c
// Enum for preprocessing result
PREPROCESSOR_DISTORTION_NOT_RECOGNIZED  ← couldn't fix perspective
```

---

## 8. Staff Detection Algorithm

```c
staffaDetect(PIX *binarized)
  └── staffaDetectPriv()
        ├── finds horizontal runs using RLE
        │     ├── rleGetRowRuns()           ── row run-lengths
        │     ├── rleFindMostFrequent()     ── most common run height
        │     └── rleGetFrequencies()       ── run-length histogram
        │
        ├── groups runs into staff lines
        │     ├── findLineGroups()          ── group by Y proximity
        │     └── findLines()               ── extract individual lines
        │
        ├── groups lines into staves (5 lines each)
        │     └── findStaffa()              ── create staff array
        │
        └── computes staff metrics
              ├── staffLineHeight()         ── line thickness
              ├── staffSpaceHeight()        ── space between lines
              └── staffHeight()             ── total staff height

staffRemoveWithScan(PIX *pix, STAFFA *staffa)
  └── erases staff lines by scanning for horizontal runs
      └── preserves noteheads/stems at line intersections
```

### 8.1 Staff Metrics (from debug strings)

```
lineHeight=%f, spaceHeight=%f, noteHeight=%f, 
widthMin=%f, widthMax=%f, heightMin=%f, heightMax=%f
```

---

## 9. Symbol Recognition Algorithms

### 9.1 Clef Recognition

```c
recognizeInitialClef(PIX *staffRemoved, STAFF *staff, TEMPLA *templates)
  ├── isTrebleClef()           ── template matching + contour checks
  │     └── trimTrebleClef()   ── clean up clef region
  │
  ├── recognizeBassClef()      ── look for two dots
  │     ├── findBassClefDots()
  │     ├── doesContainBassClefDoubleDot()
  │     └── trimBassClef()
  │
  └── recognizeClefAltoOrTenor()
        └── checks C-clef pattern ("Not a C; bottom part too narrow")
```

### 9.2 Notehead Recognition

```c
recognizeFullHeads()
  └── recognizeFullHeadsInternal()
        ├── findPrimitives()           ── CC analysis for blobs
        ├── checkNoteHollow()          ── is it hollow? (half note test)
        ├── mergeHeadsWithStems()      ── associate with stems
        │     └── mergeHeadWithStems()
        ├── headRemoveNotTouchingStems()
        └── for each head candidate:
              ├── template match vs kPNote4
              ├── checkCrotchetContours()  ── RLE contour analysis
              └── confirm or reject

recognizeWholeAndHalfNoteHeads()
  └── recognizeWholeAndHalfNoteHeadsPriv()
        ├── isWholeNoteHead()          ── template + hollow check
        │     └── wholeNoteFindVerticals()
        ├── isHalfNoteHead()           ── template + diagonal check
        │     └── halfNoteFindDiagonals()
        └── hollowNoteFindStaffLines() ── staff line intersection
```

### 9.3 Accidental Recognition

```c
// For each candidate blob near a notehead:
isSharp()
  ├── template matching for sharp symbol
  ├── check "does not intersect two lines, not a sharp"
  ├── check "verticals not confirmed, not a sharp"
  └── check "coverage too high, not a sharp"

isFlat()
  ├── flatCheckHollow()        ── belly must be hollow
  ├── flatCheckLeftVertical()  ── must have vertical stem
  ├── flatFindBellyTop()       ── locate belly curve
  ├── flatIsOneRunAtRight()    ── shape check
  └── flatCountPixelsAtTheLeft()

isNatural()
  └── template matching + shape analysis
```

### 9.4 Rest Recognition

```c
recognizeRectRests()
  └── recognizeRectRestType()
        ├── search for rectangular blob above/below middle line
        ├── "not a rect. rest, brick not found in conn. comp."
        ├── "not a rect. rest, height (= %f) < 2 * lineHeight (= %f)"
        └── distinguish kPRestWhole vs kPRestHalf by position

recognizeShortRests()
  └── findShortRest()
        ├── isCrotchet()               ── quarter rest detection
        │     ├── checkCrotchetContours()
        │     └── "merged with a vertical at the left; not a crotchet"
        ├── template match for kPRest8, kPRest16, kPRest32, kPRest64
        └── RLE-based shape analysis for each rest type
```

### 9.5 Beam Recognition

```c
recognizeBeams()
  └── beamsRecognizeInOpenedPix()
        ├── open the image to isolate thick horizontals
        ├── for each candidate:
        │     ├── beamRecognizeAttributes()
        │     │     └── "beam attributes recognized; height=%i, y0L=%i, y0R=%i"
        │     ├── beamConfirmByStemsAndCreate()
        │     │     └── beamFindStems()
        │     ├── beamProcessStems()
        │     │     └── for each stem: beamProcessStem()
        │     └── beam slope analysis: beamSlope()
        │
        └── beamsSplit() ── split multi-layer beams

assembleBeamGroups()
  ├── beamsBelongToSameGroup()     ── do beams share stems?
  ├── beamSymbolDistance()         ── spacing analysis
  └── beamSymbolPosition()         ── relative position
```

### 9.6 Stem Analysis

```c
// For each vertical line segment:
stemProcessAndConfirm()
  ├── stemExtend()                  ── extend stem to full length
  ├── stemTrimByGaps()              ── trim gaps in stem
  ├── stemCountBeams()              ── count intersecting beams
  ├── stemCountCurlyBeams()         ── flag-style beams
  ├── stemCountPrerecognizedBeams() ── from beam recognition
  ├── stemGetStemType()             ── determine note duration
  │     └── based on beam count: 0=quarter, 1=eighth, 2=16th, 3=32nd
  ├── stemAddItselfToStemHeads()    ── register in head arrays
  └── stemSetStemProperties()       ── finalize stem data
```

### 9.7 Duration Dots

```c
findDurationDots()
  └── findDurationDotBoxes()       ── locate dot candidates
        ├── getDurationAndStaccatoDotCandidates()
        ├── dotCheckBall()         ── must be circular
        ├── "dot candidate ignored, overlap too low (%f, vertical: %f)"
        ├── "dot candidate is on a staff line"
        └── may find 1 or 2 dots (double-dotted notes)
```

---

## 10. RLE (Run-Length Encoding) Shape Analysis

One of the most distinctive features. The engine uses RLE contour analysis extensively:

```c
rleGetContourTop(PIX *pix)     ── top edge profile
rleGetContourBottom(PIX *pix)  ── bottom edge profile  
rleGetContourLeft(PIX *pix)    ── left edge profile
rleGetContourRight(PIX *pix)   ── right edge profile

rleGetBlackRunCoords()         ── black run positions
rleFirstBlackRunCoords()       ── first black run per row/col
rleLastBlackRunCoords()        ── last black run per row/col
rleFindMostFrequent()          ── modal run length
rleConvexOrConcave()           ── shape convexity test
rleGetFrequencies()            ── run-length histogram
rleCollapseBlackRuns()         ── merge nearby runs
rleEraseEvenRuns()             ── remove alternate runs
rleEraseOddRuns()              ── remove alternate runs
rleEraseShortEvenRuns()        ── filter by length
rleEraseLongEvenRuns()         ── filter by length
```

This is used to distinguish symbols by their **contour shape** rather than purely template correlation. Example: crotchet rest recognition uses `checkCrotchetContours()` which analyzes the characteristic S-curve.

---

## 11. Voice Assignment & Score Construction

```c
scoreCalculateVoiceIndexes()
  ├── analyzes stem directions (up vs down)
  ├── checks for overlapping noteheads at same timepoint
  └── assigns voice 1 (stems up) vs voice 2 (stems down)

scoreAssignVoiceIndexesToSounds()
  └── propagates voice indexes to all sounds

scoreIsMultipleVoices()
  └── returns true if any staff has > 1 voice

scoreFindAndInterpretTies()
  ├── findTiedNoteCandidate()
  │     └── "Tied note candidate found."
  ├── soundReconstructTiedNotes()
  │     └── "Tied note confirmed."
  └── "Note extended by the tied note->length=%f."

scoreSetUpGroupBars()
  └── aligns bars across staves in grand staff systems
        ├── baraaAlignBarTPs()
        ├── baraaAlignParallelBars()
        └── baraaFixWholeRestBars()
```

---

## 12. Session & Serialization

The engine supports **undo/redo and session persistence** via a binary serialization format:

```
serialize/deserialize for: Session, Score, Baraa, Bara, Bar, 
TimePoint, Sound, Box, Pix, Numa, KeySignature, TimeSignature,
Barlines, BeamInfo, Double, Int
```

Version field: `serializerVersionAtCreation` — allows forward compatibility.

---

## 13. Key Thresholds & Parameters (from debug strings)

| Parameter | Context | Debug String |
|---|---|---|
| Coverage | Notehead validation | `"coverage ok: %f"`, `"coverage too high (%f)"`, `"coverage too low: %f, expected > %f"` |
| Coverage range | General | `"coverage incorrect (%f), not within <%f, %f>"` |
| Template score | Template matching | `"confirmed by template, score: %f"` (threshold ~0.7) |
| Template score | General | `"template matching score: %f"` |
| Beam coverage | Beam validation | `"beam coverage=%f"` |
| Staff coverage | Staff validation | `"staff %i coverage: %f"` |
| Min stem length | Stem detection | `"minStemLength=%i"` |
| Stem overlap | Stem validation | `"stem overlap: %i"`, `"stem overlap too low: %i, min expected: %i"` |
| Dot size | Dot detection | `"maxDistance: %i, minDotSize: %i, maxDotWidth: %i, maxDotHeight: %lf, dotDistance: %i-%i"` |
| Half note width | Half note | `"expected height=%f, half note width=%f"` |
| Whole note width | Whole note | `"expected height=%f, whole note width=%f"` |
| Staff geometry | Staff detection | `"lineHeight=%f, spaceHeight=%f, noteHeight=%f"` |

---

## 14. MusicXML Export

```c
exportToMusicXml(SESSION *session, ...)
  ├── exportGetDivisionsPerQuarterNote()
  ├── writeScorePart()
  │     ├── writeClefIfNeeded() / writeClef()
  │     ├── writeBarline()
  │     ├── writeNotesForVoice()
  │     │     ├── writeNote() / writeNote_v3()
  │     │     │     ├── writeNotePitch()
  │     │     │     ├── writeNoteType()
  │     │     │     └── writeAccidental()
  │     │     └── writeRest() / writeRest_v3()
  │     ├── writeTPClefChange()
  │     └── writeShortestNotes()
  └── exports to string/file
```

---

## 15. Summary: What Makes It Fast

1. **No neural network for symbol detection** — pure template correlation + RLE contour analysis. The CNN is only used for time signature digit OCR (tiny model).

2. **Leptonica-native operations** — `pixCorrelationScore` is heavily optimized SIMD code for binary image correlation. No Python/Java overhead in the hot loop.

3. **Single-pass architecture** — staff detection → staff removal → connected components → template match → group → export. No iterative refinement.

4. **Small template set** — ~30 symbol types × few variations = probably <100 templates total, scaled dynamically to match staff height.

5. **RLE analysis** — contour shape checking via run-length encoding is O(n) per row/column, much faster than 2D convolution.

6. **Binary (1-bit) image processing** — everything operates on binary images after initial binarization, making correlation extremely fast (population count of XOR).

---

## 16. Replication Feasibility

### What we can replicate directly:
- ✅ Binarization (Sauvola — already done in our preprocess.py)
- ✅ Staff detection (horizontal projection + RLE)
- ✅ Staff removal (horizontal run erasure)
- ✅ Connected component analysis (OpenCV)
- ✅ Template correlation matching (OpenCV `matchTemplate` or custom binary correlation)
- ✅ RLE contour analysis (straightforward to implement)
- ✅ MusicXML export (well-documented format)

### What requires significant effort:
- ⚠️ The full recognition heuristics (~450 functions of music domain logic)
- ⚠️ Voice assignment algorithm
- ⚠️ Beam grouping and duration calculation
- ⚠️ Tie interpretation
- ⚠️ Template image creation (need representative symbols at various sizes)

### Estimated effort for a basic single-voice engine:
- **Phase 1** (1-2 sessions): Staff detection + removal + template matching
- **Phase 2** (2-3 sessions): Notehead, stem, beam, rest recognition
- **Phase 3** (1-2 sessions): Duration calculation + MusicXML export
- **Phase 4** (2-3 sessions): Clef, key/time signature, accidentals
- **Phase 5** (2-3 sessions): Multi-voice, ties, dots, tuplets
- **Total: ~8-13 sessions** for feature parity with Zemsky

---

*Generated by deep reverse engineering of libsource-lib.so using nm, strings, readelf, and objdump analysis.*
