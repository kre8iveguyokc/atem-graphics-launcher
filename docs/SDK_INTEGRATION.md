# Blackmagic SDK integration

## Status

Implemented against the **Blackmagic ATEM Switchers SDK 11.0** (`native/helper/src/session_blackmagic.cpp`), built into the Windows and macOS helpers by CI. **Verified on an ATEM Mini Extreme ISO (2026-10-28)** over USB-C and Ethernet, transfers under 0.3 s, clean on-air replacement with no glitches or artifacts.

## What the helper does with the SDK

| Step | SDK call | Notes |
|---|---|---|
| Load | Windows: `CoCreateInstance(CBMDSwitcherDiscovery)` (COM, multithreaded apartment). macOS: `CreateBMDSwitcherDiscoveryInstance()` from `BMDSwitcherAPIDispatch.cpp`, which loads `/Library/Application Support/Blackmagic Design/Switchers/BMDSwitcherAPI.bundle`. | Fails with `sdk_unavailable` if the ATEM Switchers software isn't installed, or is older than the SDK. |
| Connect | `IBMDSwitcherDiscovery::ConnectTo` | Empty address = USB only (manual §2.3.1.1). With an IP, the SDK tries the network and then falls back to USB on its own. |
| Read state | `IBMDSwitcher::GetVideoMode`, `GetProductName`; `IBMDSwitcherMediaPlayer::GetSource`; `IBMDSwitcherStills::GetCount`, `IsValid`, `GetName` | Read-only. |
| Watch | `AddCallback` on switcher (disconnect, video mode), stills (name/valid, transfer results), media players (source changed) | Callbacks arrive on SDK threads; the helper never calls the SDK from them. |
| Upload | `CreateFrame(8BitARGB)` → fill → `IBMDSwitcherStills::Lock` → wait for `Obtained` → `Upload` → wait for `TransferCompleted` / `Failed` / `Cancelled` → `Unlock` | Manual §4.1.1. Frame prepared before locking, as Blackmagic's sample advises. Lock wait 10 s, transfer wait 60 s, then `CancelTransfer`. One transfer at a time (manual §4.3.8.9). |

Nothing else is called. `test/noControl.test.js` fails the build if helper code uses switching, keying, routing, macro, media-player-source or clear methods.

## Findings from the SDK

- **On-air replacement:** Blackmagic's SwitcherMediaPool sample states that when uploading to a still a media player is showing, the player keeps the existing still until the upload completes and then swaps to the new one. That is the behaviour this app relies on.
- **Pixel format:** `bmdSwitcherPixelFormat8BitARGB`, four bytes per pixel. Blackmagic's samples fill it with B,G,R,A bytes in memory (straight copy of 32-bit TGA data); the helper does the same. The SDK says nothing about premultiplication: pixel values are passed through unchanged, so premultiplied PNGs stay premultiplied and the keyer's **Pre-multiplied** setting must be on.
- **Runtime dependency:** the SDK library is installed with Blackmagic's product software and the app links to whatever version is installed (manual §1.1). Show laptops need the ATEM Switchers software at the SDK's version (11.0) or newer.
- **Video mode → frame size:** derived from the mode's four-character code (`10p9` → 1920×1080, `72p0` → 1280×720, `4H59` → 3840×2160, etc.).

## Vendored files

`native/helper/sdk/` holds only the headers needed to build, under Blackmagic's permissive SDK license (see its README). The Windows header is Blackmagic's own MIDL output from their samples; its interface GUIDs were checked against the IDL.

## To verify on hardware

- USB-only connection, and Ethernet via the SDK.
- Upload timing over USB vs Ethernet.
- Behaviour when ATEM Software Control holds the stills lock.
- Which ATEM Switchers software versions work with SDK 11.0 (oldest version that connects).
