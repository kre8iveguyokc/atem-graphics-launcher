# ATEM Graphics Launcher

Click a PNG and it replaces the still in **media pool slot 1 or 2** of a Blackmagic **ATEM Mini Extreme ISO**. Media Player 1 shows Still 1 and Media Player 2 shows Still 2, so whatever key is built on those players updates with the new graphic.

The app **only uploads stills**. It never touches keyers, program/preview, transitions or media-player assignments.

## Downloads

Every push to `main` builds three apps on GitHub Actions. Open the repo's **Actions** tab, pick the latest green **Build** run, and download from **Artifacts**:

| Artifact | For |
|---|---|
| `ATEM-Graphics-Launcher-windows-x64` | Windows laptops: a single portable `.exe`, no install |
| `ATEM-Graphics-Launcher-macos-arm64` | Apple Silicon Macs (M1 and newer) |
| `ATEM-Graphics-Launcher-macos-intel-x64` | Intel Macs |

GitHub wraps each artifact in a zip. Unzip it to get the `.exe` (Windows) or another zip containing `ATEM Graphics Launcher.app` (Mac).

### First launch on a Mac (unsigned app)

The Mac builds are not signed or notarized with an Apple Developer ID, so Gatekeeper blocks a double-click the first time:

1. Unzip and drag **ATEM Graphics Launcher.app** to Applications.
2. **Right-click** the app → **Open** → **Open**. (On recent macOS, if there's no Open button: System Settings → Privacy & Security → scroll down → **Open Anyway**.)
3. If macOS says the app "is damaged", run once in Terminal:
   `xattr -dr com.apple.quarantine "/Applications/ATEM Graphics Launcher.app"`

After the first approval it opens normally. Removing the warnings for good needs a paid Apple Developer account for signing and notarization.

### First launch on Windows

Windows SmartScreen may show "Windows protected your PC" for the unsigned `.exe`. Click **More info** → **Run anyway**.

## Switcher setup (once)

Done in ATEM Software Control or on the switcher. The app checks this but never changes it.

1. **Media Player 1 → Still 1**, **Media Player 2 → Still 2**.
2. Build the key on the media player: DSK (or upstream key) with **Fill = Media Player 1**, **Key = Media Player 1 Key**, **Pre-multiplied ON**. Same for Media Player 2 if used.
3. Note the switcher's IP (ATEM Setup utility over USB shows and sets it).

If either media player isn't on its still, the app shows a yellow **Check the switcher** bar.

## Network

The app talks to the ATEM over **Ethernet**. Either:

- Laptop and ATEM on the same network, or
- A direct cable from the laptop (USB-C Ethernet adapter is fine) to the ATEM's Ethernet port, with the laptop given a fixed IP in the same subnet. Example: ATEM `192.168.10.240`, laptop `192.168.10.50`, mask `255.255.255.0`.

ATEM Software Control can stay connected at the same time.

## Running a live event

1. Open the app. The pill at the top turns **green: Connected · <IP>**. If not: ⚙ Settings → enter the ATEM IP → **Save & connect**.
2. **Choose folder…** and pick the show's graphics folder (all PNGs at the switcher's resolution, premultiplied alpha). The folder is remembered.
3. Wait for the footer to say **Ready: N pre-encoded**. Clicks before that still work, they just take a moment longer.
4. Pick the destination: click **SLOT 1** / **SLOT 2**, or press **1** / **2**.
5. **Click a graphic.** It goes to the selected slot. **Shift+click** sends to the other slot.
   - The slot panel shows **Sending … 0.3s**, then **On slot ✓** with the time it took.
   - The card gets a red **S1** / **S2** badge while it's the one in that slot.
6. Changed your mind? Click another graphic. **The latest click always wins**: anything still waiting is dropped.

Other controls: type to filter (or press **/**), **⟳** reloads the folder after adding files, click the connection pill to force a reconnect.

### What to expect

- Lower thirds are mostly transparent and compress very well, so transfers are usually well under a second. Full-frame graphics take longer.
- If the key is on air when you click, the graphic changes **on air** the moment the transfer finishes. To change it off air, take the key down first, click, then bring it back.
- A transfer that has already started can't be cancelled by the ATEM. If you click A then B quickly, A finishes and B follows immediately.
- Errors show in red on the slot and in a pop-up. Failed transfers retry automatically twice, unless you've already clicked something newer.

## Test mode

⚙ Settings → **Test mode** simulates a switcher so operators can rehearse without hardware. A striped orange **TEST MODE** banner is shown the whole time and nothing goes to the ATEM. **Load sample graphics** gives four sample lower thirds.

Test mode is never remembered: the app always starts in live mode.

## Verification status

| Area | Status |
|---|---|
| Upload path | Uses `atem-connection` 3.10.3 `Atem.uploadStill()`, the same library Bitfocus Companion and Sofie use to upload stills. |
| Image encoding | Tested: output is byte-identical to `atem-connection`'s own encoder. PNG pixels are passed through exactly, no premultiply or colour change. |
| Latest-click-wins, retries, one transfer at a time | Tested (unit tests). |
| Never sends control commands | Tested: a source scan plus a mock switcher that fails on any call except connect / upload. |
| App launch, packaged native modules | Smoke-tested on every build platform in CI. |
| **Upload to a real ATEM Mini Extreme ISO** | **Not verified yet.** No hardware was available. Run [the hardware checklist](docs/HARDWARE_TEST.md) before first live use. |
| **On-air overwrite behaviour** | **Not verified yet.** Expected to swap cleanly when the transfer completes. Covered by the checklist. |

## Development

```bash
npm install
npm start                 # live mode
npm run start:test-mode   # simulated switcher
npm test                  # unit tests
npm run smoke             # launch app headless in test mode and exercise uploads
npm run dist:mac:arm64    # or dist:mac:x64 / dist:win
```

Code map:

- `src/main/launcher.js` – ties switcher, pre-encode cache and upload queue together
- `src/main/uploadController.js` – latest-click-wins queue with retries
- `src/main/encoder.js` – PNG decode + ATEM encoding, background pre-encode cache
- `src/main/backends/atemBackend.js` – the only code that talks to the switcher
- `src/main/backends/testBackend.js` – simulator for test mode
- `src/main/safety.js` – read-only routing checks
- `src/renderer/` – operator UI
