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
HUI is **asymmetric**:
- **Input (device → host, button press):** `B0 0F <zone>` followed by `B0 2F <port>`.
- **Output (host → device, LED on/off):** `B0 0C <zone>` followed by `B0 2C <port>`.

Port byte: high bit `0x40` set = press/on, clear = release/off; low 4 bits = port index. Sending LED state on the input CCs (`0x0F`/`0x2F`) is silently ignored by the device — that was the original mistake that made LED feedback look broken.

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

**Behavior caveat (tested 2026-05-15):** despite the "last clicked OR last hovered" wording in the docs, for **native Bitwig device parameters** it's a *live* hover tracker — both `.name()` and `.exists()` drop the moment the mouse leaves the param. Clicking doesn't make it any stickier. For **third-party plugin GUIs**, by contrast, Bitwig can't see hover at all (the plugin window is opaque), so the tracker only updates on actual touch/click events via the automation-touch protocol. With no hover-end signal to clear it, the LastClickedParameter "sticks" on the last-touched plugin param — effectively giving sticky-last-touched semantics for free, but only inside plugin GUIs. DrivenByMoss uses the same API under their `IFocusedParameter` abstraction; there is no separate "last touched" API. Practical consequence: the Lock button requires the mouse to be currently over a native-device param at press time; for plugin GUIs the last-touched param is already pinned.

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

**Scrubbing pattern** (verified — and matches DrivenByMoss's `TransportImpl`):
- `playStartPosition().set(beats)` then `jumpToPlayStartPosition()` is the API combo that reliably moves the live playhead. Direct `getPosition().inc()` does NOT scrub during playback — `getPosition()` and `playStartPosition()` are different concepts; the latter is what the playhead actually launches from.
- During playback, `jumpToPlayStartPosition()` is subject to Bitwig's transport quantize (waits for next bar by default). **Workaround:** on first scrub tick while playing, call `transport.stop()`; on the last tick + a debounce window, call `transport.play()` again. While stopped, position writes are unquantized, so scrubbing feels instant and Bitwig automatically resumes from the new `playStartPosition`. We use 100ms debounce in `SCRUB_RESUME_DELAY_MS`.
- `launchFromPlayStartPosition()` (sibling to `jumpToPlayStartPosition()`) likely is the explicitly-quantized variant — "launch" suggests clip-launch semantics. We haven't tested it.

## Architecture

### Current control bindings

| CC1 control | Bitwig binding |
|---|---|
| Jog Wheel (mode = jog, default) | scrubs the play-start position via `playStartPosition().set()` (DrivenByMoss pattern — reliably moves the live playhead, unlike `getPosition().inc()`). To bypass Bitwig's beat-quantized jumps, the first tick while playing stops the transport; `SCRUB_RESUME_DELAY_MS` (100ms) after the last tick we restart with `transport.play()`. Each tick snaps to the nearest `SCROLL_BEATS_PER_CLICK` beat then advances by `delta * SCROLL_BEATS_PER_CLICK` (encoder accelerates 1–5 at speed, so fast spins jump multiple beats). Hold AI for fine mode = ±1 beat regardless of speed. |
| Jog Wheel (mode = ai or lock) | controls `jogWheelParam` (the LastClickedParameter). In `ai` mode `isLocked = false`, so the param follows mouse hover. In `lock` mode `isLocked = true`, so the param is pinned to whatever was hovered when lock engaged. Both scale by `PARAM_SENSITIVITY` (default 3); hold AI for sensitivity=1 (fine). |
| AI button | **Tap** (press → release with no jog activity): toggles between `ai` mode and `jog` mode (going to `ai` from any state, or back to `jog` if already in `ai`). **Hold** (press → jog activity → release): acts as "fine" modifier on the jog wheel — drops magnitude multiplier (jog mode = ±1 beat; ai/lock = sensitivity 1). Tap-toggle is suppressed when a hold-scrub happened. LED on = currently in `ai` mode. |
| Lock | Toggles between `lock` mode and `jog` mode. Entering `lock` sets `jogWheelParam.isLocked(true)`, pinning to whatever the LastClickedParameter is currently tracking. **For native Bitwig device params** the mouse must be over the target at press time (the tracker drops as soon as hover ends). **For third-party plugin GUIs** the last-touched param is already pinned and persists, so the mouse can be anywhere. Refuses to enter `lock` with a popup ("nothing to lock — touch a parameter first") and a three-blink Lock LED flash when the tracker is empty. Popup includes the locked param's name on success. Mutually exclusive with `ai`. LED on = currently in `lock` mode. To re-lock to a different param: tap Lock (exit) → tap AI (follows hover) → hover new param → tap Lock. |
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

### LED feedback
LED-output infrastructure is wired (`setLed` → diffed in `flush()` → sent as HUI zone/port pairs). Earlier attempts to light LEDs failed because the script was echoing back the **input** CCs (`0x0F`/`0x2F`) — HUI uses different CCs for host→device LED messages (`0x0C`/`0x2C`). This was confirmed by reading DrivenByMoss's `HUIControlSurface.setTrigger`. The output now uses the correct CCs.

Popup notifications (`host.showPopupNotification`) remain useful as a secondary user-visible feedback channel for AI mode and fader mode changes.

## File Structure

```
bitwig-controller-script/
├── CC1.control.js          # Main controller script — place in ~/Documents/Bitwig Studio/Controller Scripts/Yamaha/
└── README.md               # This file — project context and notes
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
4. ~~Test in Bitwig — Jog Wheel, fader (motorized + touch), transport, mute/solo/arm, channel select, automation toggle~~
5. ~~Verify motorized fader output protocol~~ — `B0 00 MSB` + `B0 20 LSB` works.
6. ~~Fader mode toggle (Volume / Last Clicked)~~ — wired to Automation button.
7. ~~LED feedback~~ — works after the HUI input/output CC asymmetry was fixed.
8. **LCD keys**: configure in ControlCenter to send F13–F24 (or other unused keys), then map those in Bitwig's keyboard shortcuts to whatever's useful.
9. **Maybe**: long-press on Lock = `smartToggleLock` for one-press re-targeting. Skipped for now per current UX preference (toggle-only is simpler).

## Reference

- Bitwig API docs: `/Applications/Bitwig Studio.app/Contents/Resources/Documentation/control-surface/api/`
- Bundled script examples: `/Applications/Bitwig Studio.app/Contents/Resources/ControllerScripts/`
  - `korg/nanoKONTROL2.control.js` — best reference for transport + fader + track bank + LED feedback
  - `cme/Xkey.control.js` — minimal boilerplate
- Official JS template: `/Applications/Bitwig Studio.app/Contents/Resources/DriverTemplates/javascript-controller/Extension.control.js.ftl`
