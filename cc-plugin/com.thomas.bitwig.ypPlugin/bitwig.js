#!/usr/bin/env node
// ControlCenter plugin that forwards the CC1's 4 multi-function knobs and its two
// otherwise-unused buttons to Bitwig over a virtual MIDI port.
//
// Those controls are invisible to Simple HUI, so ControlCenter's plugin bus is the only
// way to reach them. Everything else on the device stays bound to com.yamaha.hui.* in the
// profile and keeps talking to the script over "CC Virtual MIDI Driver Port1" as before.

const fs = require("fs");
const midi = require("@julusian/midi");

const PORT_NAME = "CC1 Knobs";
const CHANNEL = 0xbf; // channel 16, so nothing can collide with HUI's channel 1
const LOG = process.env.CC1_BRIDGE_LOG || null;

// Physical left-to-right order of the top row, established by probing the hardware:
// the knobs are labelled TYPE, F, Q, G. Sends 1-4 follow that order.
const KNOB_ORDER = ["type", "f", "q", "g"];
const CC_KNOB_TURN = 0x10; // 0x10..0x13, relative: value = 64 + ticks
const CC_KNOB_PRESS = 0x14; // 0x14..0x17, 127 = down, 0 = up
const CC_BUTTON = { jog: 0x18, monitoring: 0x19 };

function log(...parts) {
  if (!LOG) return;
  fs.appendFileSync(LOG, parts.map(p => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n");
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (process.argv[i].startsWith("-")) args[process.argv[i].slice(1)] = process.argv[i + 1];
}
if (!args.port) process.exit(1);

const out = new midi.Output();
out.openVirtualPort(PORT_NAME);

function send(cc, value) {
  out.sendMessage([CHANNEL, cc, value]);
  log("midi", cc, value);
}

// instanceUUID -> which physical control it is. The host only sends the coordinates once,
// in willAppear, and identifies everything after that by instance.
const controls = new Map();

// Coordinates are stable per model; slot names are not sent at runtime, so map back from
// the (type, column, row) the host reports. Knob row 0 is the top row, left to right.
function identify(control) {
  const { type, column, row } = control;
  if (type === "Knob" && row === 0 && column < KNOB_ORDER.length) {
    return { kind: "knob", index: column };
  }
  // The two spare buttons sit at fixed coordinates: jog (2,1), monitoring (1,0).
  if (type === "LEDKeyPad" && column === 2 && row === 1) return { kind: "button", name: "jog" };
  if (type === "LEDKeyPad" && column === 1 && row === 0) return { kind: "button", name: "monitoring" };
  return null;
}

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

ws.onopen = () => ws.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));

ws.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.event === "willAppear") {
    const c = identify(d.control);
    if (c) controls.set(d.instanceUUID, c);
    return;
  }
  if (d.event === "willDisappear") {
    controls.delete(d.instanceUUID);
    return;
  }

  const c = controls.get(d.instanceUUID);
  if (!c) return;

  if (c.kind === "knob") {
    // ticks arrives signed and already accumulated, so no sign-bit unpacking. Clamp to the
    // relative-CC range rather than wrapping, or a fast spin reverses direction.
    if (d.event === "dialRotate") {
      send(CC_KNOB_TURN + c.index, Math.max(1, Math.min(127, 64 + d.ticks)));
    } else if (d.event === "dialDown") {
      send(CC_KNOB_PRESS + c.index, 127);
    } else if (d.event === "dialUp") {
      send(CC_KNOB_PRESS + c.index, 0);
    }
  } else if (c.kind === "button") {
    if (d.event === "keyDown") send(CC_BUTTON[c.name], 127);
    else if (d.event === "keyUp") send(CC_BUTTON[c.name], 0);
  }
};

ws.onclose = () => {
  out.closePort();
  process.exit(0); // don't linger as an orphan across ControlCenter restarts
};

setInterval(() => {}, 1 << 30); // stay alive
