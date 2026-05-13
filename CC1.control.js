// Yamaha CC1 Controller Script for Bitwig Studio
// Operates under Yamaha ControlCenter's "Pro Tools (Simple HUI)" profile —
// the only ControlCenter profile that exposes generic MIDI to non-Steinberg DAWs.
// Connect via "CC Virtual MIDI Driver Port1" (or whichever virtual port the
// CC1 is routed to in ControlCenter).

loadAPI(20);
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
const CC_AI_KNOB = 0x0d;
const CC_PAN_KNOB = 0x40;

// 14-bit fader: paired CCs (CC 0x00 MSB + CC 0x20 LSB). The LSB arrives via
// running status, which Bitwig delivers to onMidi with status=0x20 (not 0xB0).
const CC_FADER_MSB = 0x00;
const CC_FADER_LSB = 0x20;

// HUI buttons: zone selector + port selector pair. Port high bit (0x40) = press.
const CC_HUI_ZONE = 0x0f;
const CC_HUI_PORT = 0x2f;

// Mechanical encoders bounce: a quick forward turn can briefly register a
// reverse tick. Suppress reverses that arrive within this window of an
// opposite-direction tick.
const ENCODER_DEBOUNCE_MS = 80;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let transport;
let application;
let arranger;
let detailEditor;
let cursorTrack;
let trackVolume;
let trackPan;
let aiKnobParam;
let faderParam;

// Tracks Bitwig's active panel layout: "ARRANGE", "EDIT", or "MIX".
// Drives which view the AI knob zooms in zoom mode.
let currentPanel = "ARRANGE";

const BUTTONS = {}; // "zone:port" -> handler entry
const LED_KEYS = {}; // ledKey -> {zone, port}

let currentHuiZone = 0;
let faderMsb = 0;
let isFaderTouched = false;
let pendingFaderValue = -1;
let lastSentFaderValue = -1;
const ledState = {};
let pendingLeds = {};

// AI Knob mode: "zoom" = knob controls vertical (track-height) zoom of the
// arranger, "param" = knob controls the hovered (or locked) parameter. AI
// button toggles. Lock button engages "param" + locks in one press, or
// smart-toggles lock when already in "param".
let aiKnobMode = "zoom";

// Fader mode: "volume" = follows cursor track volume, "param" = rides the
// last-clicked parameter (separate LastClickedParameter from the AI knob).
// Automation button toggles.
let faderMode = "volume";
let faderParamName = ""; // cached for popup
let volumeValue = 0; // cached current volume (so mode toggle can refresh)
let paramValue = 0; // cached current fader-param value

let lastEncoderDelta = 0;
let lastEncoderTime = 0;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  const midiIn = host.getMidiInPort(0);
  midiIn.setMidiCallback(onMidi);
  midiIn.setSysexCallback(onSysex);

  transport = host.createTransport();
  application = host.createApplication();
  arranger = host.createArranger();
  detailEditor = host.createDetailEditor();
  cursorTrack = host.createCursorTrack("cc1-cursor", "CC1 Cursor", 0, 0, true);

  application.panelLayout().addValueObserver(function (layout) {
    currentPanel = layout;
  });
  trackVolume = cursorTrack.volume();
  trackPan = cursorTrack.pan();

  aiKnobParam = host.createLastClickedParameter("cc1-ai", "AI Knob");
  aiKnobParam
    .parameter()
    .name()
    .addValueObserver(function (name) {
      // Could push to a display later. For now just expose for debugging.
      if (DEBUG) println("AI Knob -> " + name);
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

  // LED observers
  transport.isPlaying().addValueObserver(function (v) {
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

  aiKnobParam.isLocked().addValueObserver(function (v) {
    setLed("lock", v);
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
  defineButton(0x0d, 5, toggleAIMode, null, "aiMode");
  defineButton(0x0d, 6, lockButton, null, "lock");
  defineButton(0x0e, 3, function () {
    transport.stop();
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
    case CC_AI_KNOB:
      handleAIKnob(value);
      break;
    case CC_PAN_KNOB:
      handleEncoder(trackPan, value);
      break;
    case CC_FADER_MSB:
      faderMsb = value;
      break;
    case CC_HUI_ZONE:
      currentHuiZone = value;
      break;
    case CC_HUI_PORT:
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

function handleAIKnob(value) {
  const magnitude = value & 0x3f;
  const delta = value & 0x40 ? magnitude : -magnitude;

  const now = Date.now();
  if (
    lastEncoderDelta * delta < 0 &&
    now - lastEncoderTime < ENCODER_DEBOUNCE_MS
  ) {
    return;
  }
  lastEncoderDelta = delta;
  lastEncoderTime = now;

  if (aiKnobMode === "param") {
    aiKnobParam.parameter().value().inc(delta, 128);
  } else {
    const steps = Math.abs(delta);
    const zoomIn = delta > 0;
    for (let i = 0; i < steps; i++) {
      if (currentPanel === "EDIT") {
        if (zoomIn) detailEditor.zoomInLaneHeights();
        else detailEditor.zoomOutLaneHeights();
      } else {
        if (zoomIn) arranger.zoomInLaneHeightsAll();
        else arranger.zoomOutLaneHeightsAll();
      }
    }
  }
}

function toggleAIMode() {
  aiKnobMode = aiKnobMode === "param" ? "zoom" : "param";
  setLed("aiMode", aiKnobMode === "param");
  host.showPopupNotification(
    "AI Knob: " +
      (aiKnobMode === "param" ? "Hover Parameter" : "Vertical Zoom"),
  );
}

function lockButton() {
  if (aiKnobMode === "zoom") {
    // Engage AI + lock in one press.
    aiKnobMode = "param";
    setLed("aiMode", true);
    aiKnobParam.isLocked().set(true);
    host.showPopupNotification("AI Knob: Locked to hovered parameter");
  } else {
    // Already in param mode — smart toggle (re-locks to new hover if already locked).
    aiKnobParam.smartToggleLock();
  }
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
  activeFaderParam().touch(true);
}

function onFaderTouchRelease() {
  isFaderTouched = false;
  activeFaderParam().touch(false);
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
    sendMidi(0xb0, CC_HUI_ZONE, btn.zone);
    sendMidi(0xb0, CC_HUI_PORT, btn.port | (on ? 0x40 : 0));
    ledState[ledKey] = on;
  }
  pendingLeds = {};
}

function exit() {
  println("Yamaha CC1 exiting.");
}
