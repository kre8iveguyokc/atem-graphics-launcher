# Blackmagic SDK integration status

## Done (works today)

- `agl-helper` process, protocol, PNG decode, frame cache, one-transfer-at-a-time handling (`native/helper/src`).
- `Session` interface: the only boundary between the helper and a switcher (`session.h`). It allows connect, read state and still upload, nothing else.
- No-SDK session (shipped until the SDK is added): reports "SDK not included" so the app falls back to Ethernet.
- Mock session (`agl-helper-mock`, tests only) used by CI on Windows, Intel Mac and Apple Silicon.
- App side: `HelperBackend` and `FallbackBackend` with the connection order SDK USB → SDK Ethernet → atem-connection Ethernet, automatic retry, and return to USB after a drop.
- Guard test that fails the build if helper code calls SDK switching, keying or routing methods.

## Remaining (needs the SDK zip)

1. `native/helper/src/session_blackmagic.cpp` implementing `Session` with:
   - `IBMDSwitcherDiscovery::ConnectTo` (empty address = USB only, manual p. 58)
   - read-only: video mode → width/height, product name, `IBMDSwitcherMediaPlayer` source (get only), still names
   - stills upload per manual §4.1.1 (p. 206): `GetStills` → `Lock` (wait for lock callback) → `CreateFrame` → fill buffer → `Upload` → wait for transfer completed/failed callback → `Unlock`
   - callbacks for disconnect and media pool/player changes
   - `frameLayout()` set to whatever `CreateFrame`'s pixel format needs (§4.2.1, p. 207)
2. Windows: COM (`CoCreateInstance(CLSID_CBMDSwitcherDiscovery)`), interfaces from the SDK's `BMDSwitcherAPI.idl` (MIDL output or the SDK's generated headers).
3. macOS: the SDK's `BMDSwitcherAPIDispatch.cpp`, which loads the switcher API bundle installed with ATEM Software Control.
4. CMake: `AGL_ATEM_SDK_DIR` include paths and platform libraries; CI access to the SDK headers.
5. Confirm actual runtime dependencies (which Blackmagic install provides the API on each OS, and version matching with switcher firmware).

## Open questions to answer from the SDK

- Exact pixel format and whether `CreateFrame` expects premultiplied alpha.
- Lock behaviour when ATEM Software Control holds the stills lock.
- Whether a `ConnectTo` with an IP silently falls back to USB (manual says it tries USB if the network fails), and whether the SDK reports which transport was used.
- Whether redistributing the SDK headers in this repo is allowed, or CI needs them from a private location.
