#!/usr/bin/env python3
"""Install a CC1 profile that is Yamaha's "Pro Tools / Stream Deck Link" plus the knobs.

That factory profile leaves the 4 multi-function knobs (and the jog/monitoring buttons)
unbound, which is the only reason they do nothing. We clone it verbatim -- every existing
binding stays on com.yamaha.hui.* / sdlink, so HUI MIDI and the Stream Deck keys keep
working exactly as before -- and fill in the empty slots.

ControlCenter's UI can't create or edit profiles, so we write the profile JSON and the
prefs plist directly. UUIDs are uuid5-derived => re-running overwrites, never duplicates.
Run with ControlCenter quit, then relaunch it.
"""
import copy, json, os, plistlib, subprocess, sys, uuid

DEVICE = "CC1-6D58A1D93F2931D7"
BASE = "cfc384e8-e7da-423f-88ac-e75c70ef8072"  # Pro Tools / Stream Deck Link
CUBASE_PROFILE = "214c9368-6478-4852-812f-1eeb693f8b81"  # Cubase / Stream Deck Link
NS = uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")
CC = os.path.expanduser("~/Library/Application Support/yamaha/ControlCenter")
PROFILES = f"{CC}/Profiles/{DEVICE}/Factory"

PROBE_KNOB = "com.thomas.bitwig.probeknob"
PROBE_KEY = "com.thomas.bitwig.probekey"

# All four go to our plugin. Binding them to com.yamaha.controlcenter.sdlink.sdlink was
# tried and does nothing: the Stream Deck bridge advertises the CC1 as a keys-only device,
# so the Stream Deck app has no dial slots to put them in.
KNOB_BINDINGS = {"q": PROBE_KNOB, "f": PROBE_KNOB, "g": PROBE_KNOB, "type": PROBE_KNOB}
# Free LEDKeyPad slots the factory profile never uses.
KEY_BINDINGS = {"jog": PROBE_KEY, "monitoring": PROBE_KEY}


def action(slot, action_uuid):
    return {
        "ActionID": "{%s}" % uuid.uuid5(NS, f"{slot}/{action_uuid}"),
        "Settings": {},
        "State": 0,
        "States": [{}],
        "Title": "",
        "UUID": action_uuid,
    }


def add(controllers, ctype, bindings):
    """Merge bindings into the controller of this type, creating it if absent."""
    for c in controllers:
        if c["Type"] == ctype:
            break
    else:
        c = {"Type": ctype, "Actions": {}}
        controllers.append(c)
    for slot, action_uuid in bindings.items():
        if slot in c["Actions"]:
            print(f"  ! {ctype}/{slot} already bound to {c['Actions'][slot]['UUID']}, overwriting")
        c["Actions"][slot] = action(slot, action_uuid)


with open(f"{PROFILES}/{BASE}/manifest.json") as fh:
    manifest = json.load(fh)
base_page = os.listdir(f"{PROFILES}/{BASE}/Profiles")[0]
with open(f"{PROFILES}/{BASE}/Profiles/{base_page}/manifest.json") as fh:
    page_manifest = json.load(fh)

manifest = copy.deepcopy(manifest)
add(manifest["Controllers"], "Knob", KNOB_BINDINGS)
add(manifest["Controllers"], "LEDKeyPad", KEY_BINDINGS)

profile_uuid = str(uuid.uuid5(NS, "bitwig-profile"))
page_uuid = str(uuid.uuid5(NS, "bitwig-page"))
# FolderName is the UI's category tab, and the UI only has the four Yamaha ones -- a
# "Bitwig" tab never appears, so live in Pro Tools next to the profile we cloned.
manifest["FolderName"] = "Pro Tools"
manifest["Name"] = "Bitwig"
manifest["IsFactoryProfile"] = False
manifest["Pages"] = {"Current": page_uuid, "Pages": [page_uuid]}
manifest["ProfileListIndex"] = 2  # after HUI Basic (0) and Stream Deck Link (1)


def write_profile(root, prof_uuid):
    dest = f"{root}/{prof_uuid}"
    os.makedirs(f"{dest}/Profiles/{page_uuid}", exist_ok=True)
    with open(f"{dest}/manifest.json", "w") as fh:
        json.dump(manifest, fh)
    with open(f"{dest}/Profiles/{page_uuid}/manifest.json", "w") as fh:
        json.dump(page_manifest, fh)  # 12 LCD keys, untouched: still Stream Deck's
    print("wrote", dest)


write_profile(PROFILES, profile_uuid)
# The UI lists the model's catalogue, not the device's instances, so register in both.
write_profile(f"{CC}/MasterProfiles/CC1", str(uuid.uuid5(NS, "bitwig-master")))
for c in manifest["Controllers"]:
    print(" ", c["Type"], sorted(c["Actions"]))

if "--profile-only" in sys.argv:
    sys.exit(0)

prefs = plistlib.loads(subprocess.run(
    ["defaults", "export", "com.yamaha.ControlCenter", "-"],
    capture_output=True, check=True).stdout)
prefs["devices"][DEVICE]["profileUUID"] = profile_uuid
# Enabled == in the rotation the device's prev/next-profile buttons cycle through. Keep
# whatever was already enabled (the Cubase profile) and add ours alongside it.
flags = prefs["ProfileEnabledFlags"][DEVICE]
flags[profile_uuid] = True
if not any(v for k, v in flags.items() if k != profile_uuid):
    flags[CUBASE_PROFILE] = True  # ControlCenter clears these on quit; restore a sane pair
print("enabled:", [k[:8] for k, v in flags.items() if v])
# go back in through cfprefsd, or it just overwrites our file from its cache
subprocess.run(["defaults", "import", "com.yamaha.ControlCenter", "-"],
               input=plistlib.dumps(prefs), check=True)
print("active profile ->", profile_uuid)
