// Yamaha CC1 Controller Script for Bitwig Studio
// Operates under Yamaha ControlCenter's "Pro Tools (Simple HUI)" profile —
// the only ControlCenter profile that exposes generic MIDI to non-Steinberg DAWs.
// Connect via "CC Virtual MIDI Driver Port1" (or whichever virtual port the
// CC1 is routed to in ControlCenter).

loadAPI(25);
host.setShouldFailOnDeprecatedUse(true);

host.defineController(
  "Yamaha",
  "CC1",
  "0.1",
  "A86F807F-E5BA-4047-916C-391EC950D3C8",
);
host.defineMidiPorts(1, 1);

if (host.platformIsMac()) {
  host.addDeviceNameBasedDiscoveryPair(
    ["CC Virtual MIDI Driver Port1"],
    ["CC Virtual MIDI Driver Port1"],
  );
}

// Flip to true to dump every incoming MIDI message to the controller console.
const DEBUG = false;

// ---------------------------------------------------------------------------
// CC1 MIDI Mapping — Simple HUI as exposed by Yamaha ControlCenter
// ---------------------------------------------------------------------------
// Encoders (relative): 0x40 bit set = clockwise/+, clear = counter/-, low 6 bits = magnitude.
const CC_JOG_WHEEL = 0x0d;
const CC_PAN_KNOB = 0x40;

// 14-bit fader: paired CCs (CC 0x00 MSB + CC 0x20 LSB). The LSB arrives via
// running status, which Bitwig delivers to onMidi with status=0x20 (not 0xB0).
const CC_FADER_MSB = 0x00;
const CC_FADER_LSB = 0x20;

// HUI buttons: zone selector + port selector pair. Asymmetric — input
// (device → host, button press) uses 0x0F/0x2F; output (host → device, LED)
// uses 0x0C/0x2C. Port high bit (0x40) = press/on. Sending LED state on the
// input CCs is silently ignored by the device.
const CC_HUI_ZONE_IN = 0x0f;
const CC_HUI_PORT_IN = 0x2f;
const CC_HUI_ZONE_OUT = 0x0c;
const CC_HUI_PORT_OUT = 0x2c;

// Zoom-aware jog wheel step sizes, ported from DrivenByMoss's TransportImpl
// with all step sizes shifted up by one row — DrivenByMoss's original values
// felt too fine at every zoom level in Bitwig. Now each threshold gets the
// step size that the threshold below it had originally.
// Key: 1 / contentPerPixel threshold. Value: step size in BARS — each detent
// moves `value * beatsPerBar` beats in default mode. Sorted ascending; lookup
// returns the first entry whose threshold exceeds the current
// inverse-contentPerPixel. Zoomed out → low threshold → big step (1 bar).
// Zoomed in → high threshold → tiny step (1/32768 bar).
const ZOOM_RESOLUTIONS = [
  [27.94, 1.0],
  [279.11, 1.0 / 4],
  [661.61, 1.0 / 16],
  [1176.2, 1.0 / 32],
  [2091.03, 1.0 / 64],
  [4956.52, 1.0 / 128],
  [8811.59, 1.0 / 256],
  [20886.75, 1.0 / 512],
  [37132.0, 1.0 / 1024],
  [66012.45, 1.0 / 2048],
  [156473.96, 1.0 / 4096],
  [278175.93, 1.0 / 8192],
  [600000, 1.0 / 16384],
  [800000, 1.0 / 32768],
];
// Fallback resolution when zoom is beyond the table (extreme zoom-in).
const ZOOM_RESOLUTION_FLOOR = 1.0 / 32768;

// Jog wheel in param mode: how many "steps" each detent moves the parameter,
// relative to inc()'s denominator of 128. Higher = more sensitive. 1 step ≈ 0.78%
// of the parameter range; 3 ≈ 2.3% per detent.
const PARAM_SENSITIVITY = 3;

// How long after the last jog-wheel tick before we resume playback. If the
// user was playing when scrubbing began we stop on the first tick to bypass
// Bitwig's beat quantization, then restart this many ms after the last tick.
const SCRUB_RESUME_DELAY_MS = 250;

// LED flash interval used to signal a failed Lock attempt. Six steps (on/off
// × 3) at this interval = ~480ms total at 80ms.
const LOCK_FAIL_FLASH_INTERVAL_MS = 80;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let transport;
let cursorTrack;
let trackVolume;
let trackPan;
let jogWheelParam;
let faderParam;
let arranger;

const BUTTONS = {}; // "zone:port" -> handler entry
const LED_KEYS = {}; // ledKey -> {zone, port}

let currentHuiZone = 0;
let faderMsb = 0;
let isFaderTouched = false;
// The Parameter we called touch(true) on, so the matching touch(false) goes
// to the same one even if faderMode flipped while the fader was held.
let touchedParam = null;
let pendingFaderValue = -1;
let lastSentFaderValue = -1;
const ledState = {};
let pendingLeds = {};

// Jog wheel mode: "jog" = knob scrubs the transport, "ai" = knob controls the
// currently hovered parameter (follows hover), "lock" = knob controls the
// parameter that was hovered when lock engaged (sticky). AI and Lock buttons
// each toggle into their respective mode, or back to "jog" if already there;
// they're mutually exclusive — entering one unlocks/exits the other.
let jogWheelMode = "jog";

// Fader mode: "volume" = follows cursor track volume, "param" = rides the
// last-clicked parameter (separate LastClickedParameter from the jog wheel).
// Automation button toggles.
let faderMode = "volume";
let faderParamName = ""; // cached for popup
let volumeValue = 0; // cached current volume (so mode toggle can refresh)
let paramValue = 0; // cached current fader-param value

// Cached play-start position (the "blue triangle"). The jog wheel snaps this
// to a beat boundary and advances. Pattern borrowed from DrivenByMoss — it's
// the API path that reliably scrubs the live position (direct inc() on
// getPosition() doesn't during playback).
let playStartPos = 0;
let transportPlaying = false;

// Scrub-resume state. While scrubbing, playback is stopped to bypass Bitwig's
// beat-quantized jumps. wasPlayingBeforeScrub remembers we owe the user a
// resume; scrubResumeGeneration is a token that lets each new tick invalidate
// any earlier-scheduled resume task so only the last tick's task acts.
let wasPlayingBeforeScrub = false;
let scrubResumeGeneration = 0;

// AI button tap-vs-hold state. Tap (press → release with no jog activity)
// toggles jog wheel mode. Hold (press → jog activity → release) acts as a
// "fine" modifier on the jog wheel — drops the magnitude multiplier so each
// tick is one unit (one beat in jog mode, one ×1 inc in param mode) — and
// suppresses the mode toggle on release.
let aiButtonHeld = false;
let aiButtonScrubbed = false;

// Cached name of jogWheelParam's tracked Parameter. Empty when nothing has
// been clicked/hovered yet — used to refuse the Lock toggle in that case.
let jogWheelParamName = "";

// Generation token so a fresh Lock-fail flash invalidates any in-flight one.
let lockFailFlashGeneration = 0;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  const midiIn = host.getMidiInPort(0);
  midiIn.setMidiCallback(onMidi);
  midiIn.setSysexCallback(onSysex);

  transport = host.createTransport();
  cursorTrack = host.createCursorTrack("cc1-cursor", "CC1 Cursor", 0, 0, true);

  trackVolume = cursorTrack.volume();
  trackPan = cursorTrack.pan();

  jogWheelParam = host.createLastClickedParameter("cc1-jog", "Jog Wheel");
  jogWheelParam
    .parameter()
    .name()
    .addValueObserver(function (name) {
      jogWheelParamName = name;
      if (DEBUG) println("Jog Wheel -> " + name);
    });

  faderParam = host.createLastClickedParameter("cc1-fader", "Fader Param");
  faderParam
    .parameter()
    .name()
    .addValueObserver(function (name) {
      faderParamName = name;
    });

  trackVolume.value().addValueObserver(function (val) {
    volumeValue = val;
    if (faderMode === "volume" && !isFaderTouched) pendingFaderValue = val;
  });
  faderParam
    .parameter()
    .value()
    .addValueObserver(function (val) {
      paramValue = val;
      if (faderMode === "param" && !isFaderTouched) pendingFaderValue = val;
    });

  transport.playStartPosition().addValueObserver(function (pos) {
    playStartPos = pos;
  });
  // Mark-interested (no callback) so transport.getPosition().get() returns a
  // live value when scrubbing seeds playStartPos from the moving playhead.
  transport.getPosition().markInterested();

  // Zoom-aware scrub: Arranger's horizontal scrollbar exposes contentPerPixel,
  // which we use to size each jog tick to the visible zoom level. Time
  // signature feeds the bar multiplier for the default (coarse) jog step.
  arranger = host.createArranger();
  arranger.getHorizontalScrollbarModel().getContentPerPixel().markInterested();
  transport.timeSignature().numerator().markInterested();
  transport.timeSignature().denominator().markInterested();

  // LED observers
  transport.isPlaying().addValueObserver(function (v) {
    transportPlaying = v;
    setLed("play", v);
  });
  transport.isArrangerRecordEnabled().addValueObserver(function (v) {
    setLed("record", v);
  });
  transport.isArrangerLoopEnabled().addValueObserver(function (v) {
    setLed("loop", v);
  });

  cursorTrack.mute().addValueObserver(function (v) {
    setLed("mute", v);
  });
  cursorTrack.solo().addValueObserver(function (v) {
    setLed("solo", v);
  });
  cursorTrack.arm().addValueObserver(function (v) {
    setLed("arm", v);
  });

  // HUI button table (zone, port)
  defineButton(0x00, 0, onFaderTouchPress, onFaderTouchRelease);
  defineButton(
    0x00,
    2,
    function () {
      cursorTrack.mute().toggle();
    },
    null,
    "mute",
  );
  defineButton(
    0x00,
    3,
    function () {
      cursorTrack.solo().toggle();
    },
    null,
    "solo",
  );
  defineButton(
    0x00,
    7,
    function () {
      cursorTrack.arm().toggle();
    },
    null,
    "arm",
  );
  defineButton(0x0a, 0, function () {
    cursorTrack.selectPrevious();
  });
  defineButton(0x0a, 2, function () {
    cursorTrack.selectNext();
  });
  defineButton(0x0b, 2, function () {
    trackPan.reset();
  });
  defineButton(0x0d, 5, onAIButtonPress, onAIButtonRelease, "aiMode");
  defineButton(0x0d, 6, toggleLockMode, null, "lock");
  defineButton(0x0e, 3, function () {
    transport.stop();
    // Cancel any pending scrub-resume so a user-initiated stop sticks.
    wasPlayingBeforeScrub = false;
    scrubResumeGeneration++;
  });
  defineButton(
    0x0e,
    4,
    function () {
      transport.play();
    },
    null,
    "play",
  );
  defineButton(
    0x0e,
    5,
    function () {
      transport.record();
    },
    null,
    "record",
  );
  defineButton(
    0x0f,
    3,
    function () {
      transport.isArrangerLoopEnabled().toggle();
    },
    null,
    "loop",
  );
  defineButton(0x19, 2, toggleFaderMode);

  println("Yamaha CC1 initialized.");
}

function defineButton(zone, port, onPress, onRelease, ledKey) {
  BUTTONS[zone + ":" + port] = {
    onPress: onPress || null,
    onRelease: onRelease || null,
  };
  if (ledKey) LED_KEYS[ledKey] = { zone: zone, port: port };
}

// ---------------------------------------------------------------------------
// MIDI Input
// ---------------------------------------------------------------------------
function onMidi(status, data1, data2) {
  if (DEBUG) printMidi(status, data1, data2);

  if (status === 0xb0) {
    onCC(data1, data2);
  } else if (status === CC_FADER_LSB) {
    // Running-status continuation of the fader's CC pair.
    handleFaderLSB(data1);
  }
}

function onCC(cc, value) {
  switch (cc) {
    case CC_JOG_WHEEL:
      handleJogWheel(value);
      break;
    case CC_PAN_KNOB:
      handleEncoder(trackPan, value);
      break;
    case CC_FADER_MSB:
      faderMsb = value;
      break;
    case CC_HUI_ZONE_IN:
      currentHuiZone = value;
      break;
    case CC_HUI_PORT_IN:
      handleHuiPort(value);
      break;
  }
}

function handleHuiPort(value) {
  const port = value & 0x0f;
  const isPress = (value & 0x40) !== 0;
  const btn = BUTTONS[currentHuiZone + ":" + port];
  if (!btn) return;
  if (isPress) {
    if (btn.onPress) btn.onPress();
  } else {
    if (btn.onRelease) btn.onRelease();
  }
}

function handleEncoder(param, value) {
  const magnitude = value & 0x3f;
  const delta = value & 0x40 ? magnitude : -magnitude;
  param.value().inc(delta, 128);
}

function getZoomResolution() {
  const contentPerPixel = arranger
    .getHorizontalScrollbarModel()
    .getContentPerPixel()
    .get();
  if (contentPerPixel <= 0) return 1.0;
  const inversed = 1 / contentPerPixel;
  // 1-bar tier (most zoomed out): time-signature aware, so it can't be a
  // static table entry. Checked before the table since its threshold is the
  // lowest.
  if (inversed < 2.2) return getBeatsPerBar();
  for (let i = 0; i < ZOOM_RESOLUTIONS.length; i++) {
    if (inversed < ZOOM_RESOLUTIONS[i][0]) return ZOOM_RESOLUTIONS[i][1];
  }
  return ZOOM_RESOLUTION_FLOOR;
}

function getBeatsPerBar() {
  const num = transport.timeSignature().numerator().get();
  const den = transport.timeSignature().denominator().get();
  if (den <= 0) return 4;
  return (4 * num) / den;
}

function handleJogWheel(value) {
  const magnitude = value & 0x3f;
  const delta = value & 0x40 ? magnitude : -magnitude;
  if (delta === 0) return;

  if (aiButtonHeld) aiButtonScrubbed = true;

  if (jogWheelMode !== "jog") {
    // "ai" and "lock" both drive jogWheelParam — the difference is whether
    // jogWheelParam.isLocked() is true, which is owned by setJogMode.
    const sensitivity = aiButtonHeld ? 1 : PARAM_SENSITIVITY;
    jogWheelParam
      .parameter()
      .value()
      .inc(delta * sensitivity, 128);
    return;
  }

  // Stop playback on the first scrub tick so position updates aren't
  // beat-quantized. We resume SCRUB_RESUME_DELAY_MS after the last tick.
  // Seed playStartPos from the live playhead so scrubbing grabs the moving
  // position rather than the (frozen) blue triangle from when play began.
  if (transportPlaying && !wasPlayingBeforeScrub) {
    wasPlayingBeforeScrub = true;
    playStartPos = transport.getPosition().get();
    transport.stop();
  }

  // Step size scales with the arranger's zoom level (resolution shrinks as
  // you zoom in). Default jog step is one bar; AI-held drops to the raw
  // resolution (a single grid cell at the current zoom) and ignores encoder
  // acceleration. Snap to the chosen fraction before advancing.
  const resolution = getZoomResolution();
  const fraction = aiButtonHeld ? resolution : resolution * getBeatsPerBar();
  const beatsToMove = aiButtonHeld
    ? delta > 0
      ? fraction
      : -fraction
    : delta * fraction;
  const snapped = Math.round(playStartPos / fraction) * fraction;
  const newPos = Math.max(0, snapped + beatsToMove);
  playStartPos = newPos;
  transport.playStartPosition().set(newPos);

  // Reschedule the resume task; each new tick invalidates older ones via the
  // generation token, so only the last tick's task actually fires play().
  const myToken = ++scrubResumeGeneration;
  host.scheduleTask(function () {
    if (myToken !== scrubResumeGeneration) return;
    if (wasPlayingBeforeScrub) {
      wasPlayingBeforeScrub = false;
      transport.play();
    }
  }, SCRUB_RESUME_DELAY_MS);
}

function onAIButtonPress() {
  aiButtonHeld = true;
  aiButtonScrubbed = false;
}

function onAIButtonRelease() {
  aiButtonHeld = false;
  if (!aiButtonScrubbed) toggleAIMode();
}

function toggleAIMode() {
  setJogMode(jogWheelMode === "ai" ? "jog" : "ai");
}

function toggleLockMode() {
  if (jogWheelMode === "lock") {
    setJogMode("jog");
    return;
  }
  if (!jogWheelParamName) {
    host.showPopupNotification(
      "Jog Wheel: nothing to lock — touch a parameter first",
    );
    flashLockFail();
    return;
  }
  setJogMode("lock");
}

function flashLockFail() {
  const myToken = ++lockFailFlashGeneration;
  // Six toggles = three on/off cycles, ending off.
  for (let i = 0; i < 6; i++) {
    const on = i % 2 === 0;
    host.scheduleTask(function () {
      if (myToken !== lockFailFlashGeneration) return;
      setLed("lock", on);
    }, i * LOCK_FAIL_FLASH_INTERVAL_MS);
  }
}

function setJogMode(newMode) {
  jogWheelMode = newMode;
  jogWheelParam.isLocked().set(newMode === "lock");
  setLed("aiMode", newMode === "ai");
  setLed("lock", newMode === "lock");
  const labels = {
    jog: "Jog Timeline",
    ai: "Hover Parameter",
    lock: "Locked to " + (jogWheelParamName || "parameter"),
  };
  host.showPopupNotification("Jog Wheel: " + labels[newMode]);
}

function handleFaderLSB(lsb) {
  const v14 = (faderMsb << 7) | (lsb & 0x7f);
  const normalized = v14 / 16383;
  if (faderMode === "volume") {
    trackVolume.value().set(normalized);
  } else {
    faderParam.parameter().value().set(normalized);
  }
}

function activeFaderParam() {
  return faderMode === "volume" ? trackVolume : faderParam.parameter();
}

function onFaderTouchPress() {
  isFaderTouched = true;
  touchedParam = activeFaderParam();
  touchedParam.touch(true);
}

function onFaderTouchRelease() {
  isFaderTouched = false;
  if (touchedParam) {
    touchedParam.touch(false);
    touchedParam = null;
  }
}

function toggleFaderMode() {
  faderMode = faderMode === "volume" ? "param" : "volume";
  // In param mode the fader's LastClickedParameter is locked, so hover doesn't
  // change which parameter the fader rides. Locking at this moment pins it to
  // whatever was last hovered/clicked — which is what you want if a parameter
  // happened to be under the mouse when the button was pressed.
  faderParam.isLocked().set(faderMode === "param");

  if (!isFaderTouched) {
    pendingFaderValue = faderMode === "volume" ? volumeValue : paramValue;
  }
  const label =
    faderMode === "volume"
      ? "Track Volume"
      : "Riding " + (faderParamName || "(no parameter)");
  host.showPopupNotification("Fader: " + label);
}

function onSysex(data) {
  if (DEBUG) println("SysEx: " + data);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
function setLed(ledKey, on) {
  pendingLeds[ledKey] = on;
}

function flush() {
  if (pendingFaderValue >= 0) {
    const v = Math.round(pendingFaderValue * 16383);
    if (v !== lastSentFaderValue) {
      sendMidi(0xb0, CC_FADER_MSB, (v >> 7) & 0x7f);
      sendMidi(0xb0, CC_FADER_LSB, v & 0x7f);
      lastSentFaderValue = v;
    }
    pendingFaderValue = -1;
  }

  for (const ledKey in pendingLeds) {
    const on = pendingLeds[ledKey];
    if (ledState[ledKey] === on) continue;
    const btn = LED_KEYS[ledKey];
    if (!btn) continue;
    sendMidi(0xb0, CC_HUI_ZONE_OUT, btn.zone);
    sendMidi(0xb0, CC_HUI_PORT_OUT, btn.port | (on ? 0x40 : 0));
    ledState[ledKey] = on;
  }
  pendingLeds = {};
}

function exit() {
  println("Yamaha CC1 exiting.");
}
