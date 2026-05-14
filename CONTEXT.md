# Yamaha CC1 — Bitwig Controller Script

## Goal

Replicate the Yamaha CC1's Cubase integration in Bitwig Studio, especially:
- **Jog Wheel**: a single encoder that controls whatever parameter the mouse is hovering over
- **Motorized fader**: follows selected track volume OR rides automation on any last-clicked parameter
- **Transport**: play, stop, record, rewind, forward, loop
- **4 knobs**: TBD (remote controls page, sends, or user-assignable)
- **12 LCD keys**: TBD (mute/solo/arm, scene launch, custom actions)

The Bitwig Connect 4/12 controller already does the hover-parameter thing with its jog dial — we're using the same underlying API.

## Hardware: Yamaha CC1

- USB Type-C controller. **Not directly class-compliant for MIDI** — Yamaha **ControlCenter** must be installed; it enumerates the CC1 and creates 4 virtual MIDI ports ("CC Virtual MIDI Driver Port1–4") that route to/from the hardware.
- 1 motorized 100mm touch-sensitive fader (14-bit)
- 1 Jog Wheel (relative encoder; labeled "AI Knob" on the device)
- 1 dedicated Pan knob (relative encoder, separate from the 4 multi-function knobs)
- 4 multi-function knobs above the LCD keys — **no MIDI in any available profile, not script-addressable**
- 12 LCD keys — **only send OS-level keystrokes** via ControlCenter, configurable there. Not script-addressable. Map them to Bitwig keyboard shortcuts instead.
- Transport: Play, Stop, Record, Loop. **No Rewind/Forward in Simple HUI** mode.
- Edit buttons: Pan click, AI button, Lock, Channel Next/Prev, Mute, Solo, Arm, Read/Write Automation (collide — same MIDI code)
- Monitor button and Jog button send nothing in Simple HUI.

### ControlCenter profile

ControlCenter ships with profiles for Cubase, URX, MGX, and Pro Tools. Only **Pro Tools ("Simple HUI")** sends generic MIDI; the others are proprietary Steinberg/Yamaha protocols Bitwig can't decode. We use Simple HUI — it's standard HUI underneath, which is just MIDI bytes.

In Bitwig, point the CC1 controller's MIDI in/out at "CC Virtual MIDI Driver Port1". Of the 4 virtual ports ControlCenter creates, only Port1 carries data — the other three appear to be unused (in Simple HUI mode at least).

**Verified**: in **Cubase profile**, no MIDI arrives on any of the 4 virtual ports. ControlCenter routes Cubase-mode traffic via a private IPC channel to its Cubase plugin, not over the public virtual ports. So the 4 multi-function knobs and 12 LCD keys (which would presumably send data in Cubase mode) remain unreachable from non-Steinberg DAWs. Don't bother re-testing this — try ControlCenter URX/MGX profiles before exhausting options, but the most likely path to unlocking those controls is a different ControlCenter profile, not script-side decoding.

## Discovered MIDI Map (Simple HUI)

### Encoders (relative)
| Control | CC | Encoding |
|---|---|---|
| Jog Wheel | `B0 0D vv` | bit 0x40 set = +, clear = −, low 6 bits = magnitude |
| Pan knob | `B0 40 vv` | same |

Both encoders **accelerate at speed** — magnitude is 1 at slow rates but climbs (jog wheel observed up to 5, pan similar). Any tick-handling logic that compares full delta-values across ticks will misbehave at speed; compare sign/direction instead.

### Fader (14-bit CC pair)
- MSB: `B0 00 <msb>`
- LSB: arrives via MIDI running status — **Bitwig delivers this to `onMidi` with status byte `0x20` (not `0xB0`)**, so we have to special-case it.
- Output to the motorized fader: send the same CC pair (`B0 00 msb` + `B0 20 lsb`).

### Buttons (HUI zone/port pairs)
`B0 0F <zone>` followed by `B0 2F <port>`. Port byte: high bit `0x40` set = press, clear = release; low 4 bits = port index. LED feedback uses the same pair with the host sending `0x40 | port` to light, `port` alone to extinguish.

| Control | Zone | Port |
|---|---|---|
| Fader touch | 0x00 | 0 |
| Mute | 0x00 | 2 |
| Solo | 0x00 | 3 |
| Arm | 0x00 | 7 |
| Track Prev | 0x0A | 0 |
| Track Next | 0x0A | 2 |
| Pan click | 0x0B | 2 |
| AI button | 0x0D | 5 |
| Lock | 0x0D | 6 |
| Stop | 0x0E | 3 |
| Play | 0x0E | 4 |
| Record | 0x0E | 5 |
| Loop | 0x0F | 3 |
| Automation (read = write) | 0x19 | 2 |

## Key Bitwig API (v20+)

### `host.createLastClickedParameter(id, name)` → `LastClickedParameter`
The core feature. Returns an object tracking whichever parameter the user last clicked/hovered in the GUI.

- `.parameter()` → `Parameter` — the actual parameter (read/write value, name, touch for automation)
- `.parameterColor()` → `ColorValue` — color of the parameter in the GUI
- `.isLocked()` → `SettableBooleanValue` — whether locked to current param
- `.smartToggleLock()` — toggle lock; if already locked and mouse is on a different param, re-lock to that one

### `Parameter` interface
- `.value()` → `SettableRangedValue` — normalized 0.0-1.0, supports `.set()`, `.inc()`, `.addValueObserver()`
- `.name()` → observable string
- `.touch(boolean)` — signal fader touch for automation recording
- `.reset()` — reset to default
- `.modulatedValue()` — read modulated value

### `host.createCursorTrack(id, name, numSends, numScenes, shouldFollowSelection)`
Follows the selected track. `.volume()`, `.pan()`, `.mute()`, `.solo()`, `.arm()` all return `Parameter`.

### Transport
`host.createTransport()` → `.play()`, `.stop()`, `.record()`, `.rewind()`, `.fastForward()`, `.toggleLoop()`, `.isPlaying()`, `.isRecording()`, etc.

## Architecture

### Current control bindings

| CC1 control | Bitwig binding |
|---|---|
| Jog Wheel (mode = jog, default) | scrubs the play-start position via `playStartPosition().set()` + (if playing) `jumpToPlayStartPosition()`. Pattern borrowed from DrivenByMoss — this is the API combo that reliably moves the live playhead during playback (direct `getPosition().inc()` does not). Each tick snaps to the nearest `SCROLL_BEATS_PER_CLICK` beat boundary, then advances by one step; encoder magnitude is ignored so fast spins don't leap. |
| Jog Wheel (mode = param) | controls last-clicked/hovered parameter. Scaled by `PARAM_SENSITIVITY` (default 3) so ~1 full rotation goes 0→100% rather than ~2.5. |
| AI button | toggles Jog Wheel mode (jog ↔ param). Shows popup. LED on = param mode. |
| Lock | from jog: engages param mode + locks to hovered param. From param mode: `smartToggleLock` (re-locks to new hover if already locked). LED reflects `isLocked`. |
| Pan knob | cursor track pan |
| Pan click | reset pan to 0 |
| Fader (mode = volume, default) | cursor track volume (motorized, follows track selection) |
| Fader (mode = param) | rides the parameter that was last hovered/clicked at the moment the mode was engaged. Locked — does not follow further hovers until mode is toggled. |
| Fader touch | calls `.touch(true/false)` on whichever parameter the fader is currently bound to |
| Automation button | toggles fader mode (volume ↔ param). Shows popup with the riding param's name. Read/Write Auto are the same physical MIDI code, so both keys do this. |
| Play / Stop / Record / Loop | transport |
| Mute / Solo / Arm | cursor track |
| Track Next / Prev | `cursorTrack.selectNext()` / `selectPrevious()` |

### Jog Wheel
Uses `host.createLastClickedParameter()`. The encoder sends relative CCs, so we use `param.value().inc(delta, resolution)`.

### Flush Pattern
Bitwig calls `flush()` when it's time to send output. We accumulate pending state (fader position, LED states) and send in `flush()` to avoid flooding MIDI output. LED state is diffed against last-sent so we don't re-transmit unchanged values.

### LED feedback (verified non-functional)
LED-output infrastructure is wired (`setLed` → diffed in `flush()` → sent as HUI zone/port pairs), but **lighting up Play/Stop/Record/Mute/Solo/Arm/Lock LEDs on the CC1 does not work** even with a 1Hz `90 00 00` ping. ControlCenter's "Simple HUI" profile evidently does not forward LED commands back to the device. The fader motor DOES respond to host output, so output isn't entirely dropped — just the LED zone/port pairs.

Things to try if revisiting:
- Note-based LED encoding (`90 <note> 7F` / `80 <note> 00`) used by some HUI variants.
- Full HUI handshake SysEx instead of the simple ping.
- Sniff what Bitwig's built-in HUI controller sends when controlling LED-lit gear, then mirror that exact byte sequence.

For now, popup notifications (`host.showPopupNotification`) are the user-visible feedback for AI mode and fader mode changes.

## File Structure

```
bitwig-controller-script/
├── CC1.control.js          # Main controller script — place in ~/Documents/Bitwig Studio/Controller Scripts/Yamaha/
└── CONTEXT.md              # This file — project context and notes
```

The script is a single `.control.js` file. No build step needed. To install:
```bash
mkdir -p ~/Documents/Bitwig\ Studio/Controller\ Scripts/Yamaha
cp CC1.control.js ~/Documents/Bitwig\ Studio/Controller\ Scripts/Yamaha/
```
Then add in Bitwig: Settings → Controllers → Add Controller → Yamaha → CC1.

## Next Steps

1. ~~Get the CC1 hardware and connect it~~
2. ~~MIDI discovery~~
3. ~~Wire up controls~~
4. **Test in Bitwig** — verify Jog Wheel, fader (motorized + touch), transport, mute/solo/arm, channel select, automation toggle.
5. **Verify motorized fader output protocol.** We're sending `B0 00 MSB` + `B0 20 LSB`. If the fader doesn't move, try pitch bend (`E0 lsb msb`) — some HUI implementations expect that.
6. **Consider adding a fader mode toggle** (Track Volume vs Last Clicked) — Lock button is a candidate trigger.
7. **LCD keys**: configure in ControlCenter to send F13–F24 (or other unused keys), then map those in Bitwig's keyboard shortcuts to whatever's useful.

## Reference

- Bitwig API docs: `/Applications/Bitwig Studio.app/Contents/Resources/Documentation/control-surface/api/`
- Bundled script examples: `/Applications/Bitwig Studio.app/Contents/Resources/ControllerScripts/`
  - `korg/nanoKONTROL2.control.js` — best reference for transport + fader + track bank + LED feedback
  - `cme/Xkey.control.js` — minimal boilerplate
- Official JS template: `/Applications/Bitwig Studio.app/Contents/Resources/DriverTemplates/javascript-controller/Extension.control.js.ftl`
