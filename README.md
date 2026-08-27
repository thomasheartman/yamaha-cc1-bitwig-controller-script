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
- 4 multi-function knobs above the LCD keys — no MIDI in any profile, but **reachable through the ControlCenter plugin bus** (see below). Labelled TYPE, F, Q, G left to right.
- 12 LCD keys — no MIDI. Either OS-level keystrokes via ControlCenter, or handed to the Stream Deck app by the `sdlink` bridge, or **reachable through the plugin bus**.
- Transport: Play, Stop, Record, Loop. **No Rewind/Forward in Simple HUI** mode.
- Edit buttons: Pan click, AI button, Lock, Channel Next/Prev, Mute, Solo, Arm, Read/Write Automation (collide — same MIDI code)
- Monitor button and Jog button send nothing in Simple HUI.

### ControlCenter profile

ControlCenter ships with profiles for Cubase, URX, MGX, and Pro Tools. Only **Pro Tools ("Simple HUI")** sends generic MIDI; the others are proprietary Steinberg/Yamaha protocols Bitwig can't decode. We use Simple HUI — it's standard HUI underneath, which is just MIDI bytes.

In Bitwig, point the CC1 controller's MIDI in/out at "CC Virtual MIDI Driver Port1". Of the 4 virtual ports ControlCenter creates, only Port1 carries data — the other three appear to be unused (in Simple HUI mode at least).

**Verified**: in **Cubase profile**, no MIDI arrives on any of the 4 virtual ports — not even sysex (the script registers `setSysexCallback`, so nothing is being silently dropped). ControlCenter routes Cubase-mode traffic over a private channel to its Cubase plugin. There is nothing on the MIDI bus to intercept, so don't go hunting for it.

That private channel turned out to be the way in anyway — see below. The controls that Simple HUI can't see are reached by writing a ControlCenter plugin, not by decoding MIDI.

## ControlCenter's plugin bus

**ControlCenter (v5.0.0) is a near-verbatim clone of the Elgato Stream Deck plugin SDK.** This is the single most useful fact about the device. Plugins are separate processes launched by ControlCenter with:

```
<plugin-binary> -port 52832 -pluginUUID com.thomas.bitwig \
  -registerEvent registerPlugin -info '{...}' -hostID ControlCenter
```

They connect to `ws://127.0.0.1:<port>` and send `{"event":"registerPlugin","uuid":"<pluginUUID>"}`. After that it's Stream Deck's event vocabulary verbatim. The CC1's knobs are, at the protocol level, Stream Deck + dials.

**ControlCenter loads unsigned third-party plugins.** There is no code-signature check and the plugin directory is user-writable, so a shell script works as the executable — Yamaha's own plugins are signed Mach-O binaries, but that isn't enforced on ours. Note it must not be a `#!/usr/bin/env node` script; see the PATH gotcha under Architecture.

### Plugin layout

`~/Library/Application Support/yamaha/ControlCenter/Plugins/<uuid>.ypPlugin/`, containing a `manifest.json` (`"sdk": 2`, `platforms.macos.main` naming the executable, and an `actions[]` array where each action declares a `uuid`, `states[].image`, and which `controls` types it accepts) plus that executable. Yamaha's plugins keep their property-inspector HTML/JS unminified under `source/`, which is the closest thing to documentation that exists.

### Inbound events (device → plugin) — all verified on hardware

| Event | Payload | Notes |
|---|---|---|
| `deviceDidConnect` | `controls[]`, `device` | Full inventory of every slot, as `{type, column, row}` |
| `willAppear` / `willDisappear` | `control`, `instanceUUID`, `actionUUID` | The **only** time coordinates are sent; everything after is identified by `instanceUUID` |
| `dialRotate` | `{ticks, pressed}` | `ticks` is **signed and pre-accumulated** (−4…+3 observed) — no HUI sign-bit unpacking. `pressed` gives a free shift modifier per knob |
| `dialDown` / `dialUp` | `{}` | The knobs click |
| `keyDown` / `keyUp` | `{}` | LCD keys and lit buttons alike |
| `sliderMove` | `{position}` | Normalised float, e.g. `0.5620723366737366` — not a 14-bit CC pair |
| `sliderPress` / `sliderRelease` | `{}` | The fader's touch sensor |

### Outbound events — do not work

`setTitle`, `setState` and `setFeedback` were all sent, with both `context` and `instanceUUID` as the id key (both strings appear in the binary). The host accepted every frame without error or disconnect and **nothing happened**: no key text, no LEDs, no fader movement. Key visuals appear to come from the profile's static `states[].image`, not from anything sent at runtime.

So treat the plugin bus as **input-only**. LED feedback and the motorised fader still work — over HUI, on the MIDI port, exactly as before. The two channels coexist happily.

### What the plugin bus cannot reach

`pan` (rotate *and* press), `lock`, **jog-wheel press**, and the prev/next-profile buttons deliver nothing to plugins, even when bound to a plugin action. ControlCenter keeps them. All except jog-wheel press still work over HUI, so bind those slots to `com.yamaha.hui.*` and let the existing MIDI path handle them.

Note that `jog` and `monitoring` are typed `LEDKeyPad`, so the hardware does have lamps behind them — but HUI has no address for either (found by sweeping, same as the R key) and plugin output is ignored, so **they are permanently dark**. Only use them for stateless actions.

## Profile format

ControlCenter's UI cannot create or edit profiles, so `cc-plugin/install-profile.py` writes them directly. Everything is plain JSON and a plist; all of it is user-writable.

```
~/Library/Application Support/yamaha/ControlCenter/
├── Plugins/<uuid>.ypPlugin/          # plugin code
├── MasterProfiles/CC1/<uuid>/        # catalogue per model — the UI lists from here
└── Profiles/<device-uuid>/Factory/<uuid>/
    ├── manifest.json                 # device-level controls
    └── Profiles/<page-uuid>/manifest.json   # per-page controls (the 12 LCD keys)
```

A profile must exist in **both** `MasterProfiles` and `Profiles` (under different UUIDs) or it won't appear in the UI. Miss the page manifest and ControlCenter logs `[PageProfile::apply] Failed to open manifest file`, applies the bindings, then immediately tears them down again.

Bindings are per-slot, and a slot can point at **any plugin's action** — that's what makes hybrids possible. Slot names, harvested from the factory profiles and `strings` on the ControlCenter binary:

| Controller type | Slot names |
|---|---|
| `Knob` (6) | `type`, `f`, `q`, `g` (top row, left to right = columns 0–3), `pan`, `jog-wheel` |
| `KeyPad` (12) | `lcd-0-0` … `lcd-2-3` — the LCD keys, page-level |
| `LEDKeyPad` (16) | `ai`, `channel-select-left`, `channel-select-right`, `jog`, `lock`, `loop`, `monitoring`, `mute`, `pause`, `pedal-switch`, `play`, `read`, `record`, `record-enable`, `solo`, `write` |
| `SmartSlider` / `Slider` | `fader-1` / `pedal-volume` |

Other fields that matter:

- **`FolderName` is the UI's category tab**, and the UI only has the four Yamaha ones — a custom category never appears. Ours says `Pro Tools`.
- `~/Library/Preferences/com.yamaha.ControlCenter.plist` holds `devices.<id>.profileUUID` (the active profile) and `ProfileEnabledFlags` (which profiles the device's prev/next-profile buttons cycle through). ControlCenter rewrites this on quit, so edit it while the app is stopped, and go through `defaults import` rather than writing the file — otherwise cfprefsd overwrites you from its cache.
- There is **no `switchToProfile`** — Yamaha dropped that part of the SDK, so a plugin cannot change profiles. Switching is manual, via the UI or the device's profile buttons.
- The `sdlink` bridge advertises the CC1 to the Stream Deck app as a **keys-only device** (12 keys, like a Stream Deck MK.2). Binding a `Knob` slot to `com.yamaha.controlcenter.sdlink.sdlink` does nothing — the app has no dial slots. Tested.

Careful: killing ControlCenter means `/Applications/ControlCenter.app`, **never** Apple's `/System/Library/CoreServices/ControlCenter.app`.

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

**LED output addresses don't always match the input address**, and the CC1's lamp routing does **not** follow the HUI spec — treat the spec as a hint, not ground truth. The Automation button *reports input* at zone `0x19`/port 2, but its **W (Write) key LED is wired to the channel-1 strip AUTO lamp at zone `0x00`/port 4** (alongside mute/solo/arm at `0x00`/2,3,7). The HUI-spec auto-mode LED addresses (`0x18`/2 for read, `0x18`/4 for write) are dead on this device — verified by sweeping. The **R (Read) key has no host-addressable LED** in Simple HUI. When a lamp won't light, sweep the whole space empirically (see "LED feedback" below) rather than trusting the spec.

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

**Detecting an in-progress recording / count-in** (used by the Record restart-the-take, verified against the API sources + DrivenByMoss): there is **no** transport-level "actively capturing" boolean. `isArrangerRecordEnabled()` is just the record *arm* state (true through count-in too) and `isPlaying()` is *also* true during count-in, so neither distinguishes count-in from real capture. The reliable signal is **position vs. the play-start anchor**: during pre-roll/count-in the live `getPosition()` sits *below* `playStartPosition()` (the blue triangle), and crosses it exactly when capture begins. So "a recording is rolling" = `isArrangerRecordEnabled() && isPlaying()`, and "something was actually captured" = `getPosition() >= playStartPosition()`. (A true per-take boolean, `ClipLauncherSlot.isRecording()`, exists only for *clip-launcher* recording, not the arranger; and there's no global aggregate of it.)

### `host.createApplication()` → `Application`
- `.undo()` / `.redo()` — generic, no args; undoes the *last* undoable action (so the Record retake's undo can hit a concurrent clip take). `createApplicationSection()` is the deprecated variant — use `createApplication()`.

## Architecture

The CC1 reaches Bitwig over **two** MIDI inputs:

1. **`CC Virtual MIDI Driver Port1`** — HUI, produced by Yamaha's own plugin. Transport, fader (in and motorised out), pan, lock, mute/solo/arm, jog wheel, LED feedback. Unchanged from before.
2. **`CC1 Knobs`** — a virtual CoreMIDI source published by our ControlCenter plugin in `cc-plugin/`, carrying the 4 knobs and the jog/monitor buttons. Channel 16 (`0xBF`) so it can never collide with HUI's channel 1.

| Control | CC | Value |
|---|---|---|
| Knobs TYPE, F, Q, G | `0x10`–`0x13` | `64 + ticks`, clamped to 1…127 (Bitwig calls this Relative Bin Offset) |
| Knob press | `0x14`–`0x17` | 127 down, 0 up |
| jog / monitor buttons | `0x18` / `0x19` | 127 down, 0 up |

The active ControlCenter profile is a **verbatim clone of `Pro Tools / Stream Deck Link`** with the empty slots filled in: the 4 knobs and the `jog`/`monitoring` buttons point at our plugin, and every other slot stays on `com.yamaha.hui.*` / `sdlink` exactly as Yamaha shipped it. That's why HUI keeps working untouched.

**Gotchas:**

- Our plugin only receives events **while our profile is active**. Switch the CC1 to a Cubase profile and the knobs go quiet — that is the first thing to check when they stop working.
- The `CC1 Knobs` port only exists while ControlCenter is running, so auto-discovery can fail if Bitwig starts first. Pick the ports by hand once and Bitwig remembers.
- **ControlCenter launches plugins with a minimal PATH** — `/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin`, with no `/opt/homebrew/bin`. A `#!/usr/bin/env node` shebang therefore exits 127, and ControlCenter respawns the plugin in a tight loop forever without surfacing anything: no port, no error, no dialog. That's why `bitwig` is a `/bin/sh` launcher that locates node itself and execs `bitwig.js`. Beware that starting ControlCenter with `open -a` from a terminal *does* pass your shell's PATH, so it will appear to work when tested that way and fail when launched normally at login. `install.sh` checks for this and refuses to install.
- `defineMidiPorts` is read when Bitwig **scans scripts at launch**. Changing the port count needs a full Bitwig restart; removing and re-adding the controller is not enough, and you'll get `Invalid MIDI port index` until you do.

### Current control bindings

| CC1 control | Bitwig binding |
|---|---|
| Jog Wheel (mode = jog, default) | scrubs the play-start position via `playStartPosition().set()` (DrivenByMoss pattern — reliably moves the live playhead, unlike `getPosition().inc()`). To bypass Bitwig's beat-quantized jumps, the first tick while playing stops the transport; `SCRUB_RESUME_DELAY_MS` (250ms) after the last tick we restart with `transport.play()`. First scrub tick while playing also seeds `playStartPos` from the live `transport.getPosition()` so scrubbing grabs the moving playhead, not the static blue triangle. Step size is **zoom-aware**: each tick snaps to a fraction from `ZOOM_RESOLUTIONS` (lookup table indexed by `1 / arranger.getHorizontalScrollbarModel().getContentPerPixel()`, ported from DrivenByMoss). Default step = `resolution * beatsPerBar` (one bar in the current time signature) times encoder delta, so a fast spin still jumps further. Hold AI for fine mode = ±resolution (single grid cell at current zoom, no encoder accel). |
| Jog Wheel (mode = ai or lock) | controls `jogWheelParam` (the LastClickedParameter). In `ai` mode `isLocked = false`, so the param follows mouse hover. In `lock` mode `isLocked = true`, so the param is pinned to whatever was hovered when lock engaged. Both scale by `PARAM_SENSITIVITY` (default 3); hold AI for sensitivity=1 (fine). |
| AI button | **Tap** (press → release with no jog activity): toggles between `ai` mode and `jog` mode (going to `ai` from any state, or back to `jog` if already in `ai`). **Hold** (press → jog activity → release): acts as "fine" modifier on the jog wheel — drops magnitude multiplier (jog mode = ±1 beat; ai/lock = sensitivity 1). Tap-toggle is suppressed when a hold-scrub happened. LED on = currently in `ai` mode. |
| Lock | Toggles between `lock` mode and `jog` mode. Entering `lock` sets `jogWheelParam.isLocked(true)`, pinning to whatever the LastClickedParameter is currently tracking. **For native Bitwig device params** the mouse must be over the target at press time (the tracker drops as soon as hover ends). **For third-party plugin GUIs** the last-touched param is already pinned and persists, so the mouse can be anywhere. Refuses to enter `lock` with a popup ("nothing to lock — touch a parameter first") and a three-blink Lock LED flash when the tracker is empty. Popup includes the locked param's name on success. Mutually exclusive with `ai`. LED on = currently in `lock` mode. To re-lock to a different param: tap Lock (exit) → tap AI (follows hover) → hover new param → tap Lock. |
| Pan knob | cursor track pan |
| Pan click | reset pan to 0 |
| Fader (mode = volume, default) | cursor track volume (motorized, follows track selection) |
| Fader (mode = param) | rides the parameter that was last hovered/clicked at the moment the mode was engaged. Locked — does not follow further hovers until mode is toggled. |
| Fader touch | calls `.touch(true/false)` on whichever parameter the fader is currently bound to |
| Automation button | toggles fader mode (volume ↔ param). Shows popup with the riding param's name. Read/Write Auto are the same physical MIDI code, so both keys do this. The **W (Write) key LED lights while the fader is riding a parameter** (param mode) and is dark in volume mode. |
| Play / Stop / Loop | transport |
| Record | Normally `transport.record()`. **Restart-the-take:** if a recording is already rolling (arranger record enabled + transport playing), pressing Record stops and re-records from the same spot instead — `transport.stop()` returns the playhead to the take's start, then `record()` relaunches. If actual capture has begun it also `application.undo()`s the take just stopped so the retake replaces it rather than stacking; during count-in (playhead still below the play-start anchor, so nothing recorded yet) it skips the undo and just restarts with a fresh count-in. Steps are spaced by `RECORD_RESTART_DELAY_MS` (100ms) since they're engine-queued. Tradeoff: a simultaneous clip-launcher recording is undone too — there's no cheap way to detect active clip recording. |
| Mute / Solo / Arm | every selected track, via the `toggle_track_mute` / `toggle_track_solo` / `toggle_track_arm` application actions rather than `cursorTrack.mute().toggle()` — the actions follow Bitwig's own track selection, so multi-select works for free. LEDs still observe the cursor track, same as Bitwig's own buttons. |
| Track Next / Prev | `cursorTrack.selectNext()` / `selectPrevious()` |
| Knobs TYPE / F / Q / G | sends 1–4 on the cursor track, via `sendBank.getItemAt(n).value().inc(ticks, SEND_RESOLUTION)`. One detent = 2%. |
| Knob press | toggles that send's `isEnabled()`. `markInterested()` on each, since `toggle()` reads current state. |
| jog button | Shift-Tab — into the detail editor and back to whichever layout you came from (tracked in `lastNonEditLayout`) |
| monitor button | Selects the track owning the selected clip (`Clip.getTrack()` + `selectInEditor()`/`selectInMixer()`) — Bitwig's "select track on clip selection", on demand. Cursor clips follow the *clip selection*, not the playhead, so it still works long after you've scrubbed away. See "Clip cursors" below for why there are two. |

### Jog Wheel
Uses `host.createLastClickedParameter()`. The encoder sends relative CCs, so we use `param.value().inc(delta, resolution)`.

### Flush Pattern
Bitwig calls `flush()` when it's time to send output. We accumulate pending state (fader position, LED states) and send in `flush()` to avoid flooding MIDI output. LED state is diffed against last-sent so we don't re-transmit unchanged values.

### LED feedback
LED-output infrastructure is wired (`setLed` → diffed in `flush()` → sent as HUI zone/port pairs). Earlier attempts to light LEDs failed because the script was echoing back the **input** CCs (`0x0F`/`0x2F`) — HUI uses different CCs for host→device LED messages (`0x0C`/`0x2C`). This was confirmed by reading DrivenByMoss's `HUIControlSurface.setTrigger`. The output now uses the correct CCs.

Popup notifications (`host.showPopupNotification`) remain useful as a secondary user-visible feedback channel for AI mode and fader mode changes.

**Finding a lamp's address empirically:** the CC1 does not light every HUI address, and the ones it does light don't always match the spec or the button's own input address (the W-key LED is the prime example — see the MIDI map above). When a new lamp won't respond, sweep for it: temporarily route the jog wheel to step a single linear HUI index across the whole space (`zone = index >> 3`, `port = index & 7`), lighting one address at a time and showing it in a popup, and spin until the target key lights. This is how the W-key lamp (`0x00`/4) was found after the spec-derived addresses all came up dead. The probe code isn't kept in the script — re-add it behind a flag when needed.


### Clip cursors

`host.createCursorClip()` is **the launcher cursor** on this build, not a
"whichever timeline you last touched" cursor — verified by holding all three
factories at once and printing `exists()`: the generic one tracked the launcher
cursor exactly, and reported `exists=false` until a launcher clip had been
selected at least once in the session.

So the script holds `createArrangerCursorClip` **and** `createLauncherCursorClip`.
Each keeps its own last selection indefinitely and neither is aware of the
other, so "the selected clip" is whichever cursor changed most recently —
tracked with a counter bumped from observers on `exists()`, the owning track's
`name()`, and `getPlayStart()`. Any one of those alone misses cases (selecting a
second clip on the same track doesn't change the name; two clips can share a
start position), together they catch everything that comes up in practice.

## File Structure

```
bitwig-controller-script/
├── CC1.control.js                        # Bitwig controller script
├── install.sh                            # places everything; --link for development
├── cc-plugin/
│   ├── install-profile.py                # writes the ControlCenter profile + prefs
│   └── com.thomas.bitwig.ypPlugin/       # the ControlCenter plugin
│       ├── manifest.json                 # actions the profile binds to
│       ├── bitwig                        # launcher: finds node without relying on PATH
│       ├── bitwig.js                     # the plugin itself: WebSocket in, MIDI out
│       ├── package.json                  # @julusian/midi (prebuilt, no compiler needed)
│       └── image/                        # action icons, borrowed from Yamaha's HUI plugin
└── README.md
```

### Installing

```bash
./install.sh          # copy mode
./install.sh --link   # symlink mode
```

It runs `npm ci`, places the control script and the plugin, writes the ControlCenter profile, and restarts ControlCenter. Then two things by hand: pick **Pro Tools → Bitwig** in ControlCenter, and in Bitwig set the CC1's two MIDI inputs to `CC Virtual MIDI Driver Port1` and `CC1 Knobs`.

**Which mode:** copying survives this repo being moved or deleted but goes stale the moment you edit anything here — and stale is the nastier failure, because everything keeps working, just as an older version. Symlinking keeps edits live but pins the repo to its current path; if you move it, ControlCenter silently skips the plugin and the knobs go dead. Use `--link` while changing things, plain `./install.sh` once it settles.

Copy mode drops an `INSTALLED-FROM.txt` beside the plugin's manifest recording the source path, commit and date, since a copy otherwise carries no clue where it came from:

```
$ cat ~/Library/Application\ Support/yamaha/ControlCenter/Plugins/com.thomas.bitwig.ypPlugin/INSTALLED-FROM.txt
/Users/thomas/code/bitwig-controller-script
commit 60c2f8793489-dirty
copied 2026-08-01 15:39
```

Compare that commit against the repo to tell whether the running plugin is behind. The `-dirty` suffix means the copy was taken from an edited working tree, so the commit alone doesn't identify it. It reads `git describe`, not `jj` — git is the one that can be assumed installed, and it reports the last real commit rather than jj's working-copy commit. Nothing equivalent exists for `CC1.control.js` — it's a bare file in Bitwig's scripts directory, so check its contents if you suspect it's stale.

Everything outside this repo is either placed by `install.sh` or generated by `install-profile.py`, so the repo is the whole of it. The one exception is `~/Library/Preferences/com.yamaha.ControlCenter.plist`, which is edited in place — `install-profile.py` backs it up to `.plist.bak` the first time it runs, restored with `defaults import com.yamaha.ControlCenter <that file>` while ControlCenter is quit.

**Dependencies are pinned exactly** (`@julusian/midi` at 3.8.0, no caret) with `package-lock.json` committed, so `npm ci` installs the same build forever. Nothing here benefits from dependency updates; if it works, it works. `node_modules/` is gitignored since the package ships a prebuilt, arch-specific native binary — which is why `install.sh` runs `npm ci` rather than assuming it's there.

## Next Steps

1. ~~Get the CC1 hardware and connect it~~
2. ~~MIDI discovery~~
3. ~~Wire up controls~~
4. ~~Test in Bitwig — Jog Wheel, fader (motorized + touch), transport, mute/solo/arm, channel select, automation toggle~~
5. ~~Verify motorized fader output protocol~~ — `B0 00 MSB` + `B0 20 LSB` works.
6. ~~Fader mode toggle (Volume / Last Clicked)~~ — wired to Automation button.
7. ~~LED feedback~~ — works after the HUI input/output CC asymmetry was fixed.
8. ~~**4 multi-function knobs**~~ — reached via a custom ControlCenter plugin; driving sends 1–4, press toggles the send.
9. ~~**jog / monitor buttons**~~ — reached the same way; detail-editor toggle and clip-track select.
10. **LCD keys**: currently handed to the Stream Deck app by `sdlink`, which works well. The plugin bus can take them instead (all 12 report `keyDown`/`keyUp`) — but only as unlabelled inputs, since we can't draw on them. Only worth it if you want the keys to know about Bitwig state.
11. **Maybe**: long-press on Lock = `smartToggleLock` for one-press re-targeting. Skipped for now per current UX preference (toggle-only is simpler).
12. **Unresolved**: plugin-bus output. `setTitle`/`setState`/`setFeedback` are accepted and ignored. Worth another look only if you want LCD key labels — the remaining lead is Yamaha's plugin binaries, which do render icons somehow.

## Reference

- Bitwig API docs: `/Applications/Bitwig Studio.app/Contents/Resources/Documentation/control-surface/api/`
- Bundled script examples: `/Applications/Bitwig Studio.app/Contents/Resources/ControllerScripts/`
  - `korg/nanoKONTROL2.control.js` — best reference for transport + fader + track bank + LED feedback
  - `cme/Xkey.control.js` — minimal boilerplate
- Official JS template: `/Applications/Bitwig Studio.app/Contents/Resources/DriverTemplates/javascript-controller/Extension.control.js.ftl`
