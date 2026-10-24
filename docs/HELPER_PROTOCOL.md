# agl-helper protocol

`agl-helper` is a small native process that talks to the switcher through the official Blackmagic ATEM Switchers SDK. The Electron app starts one helper per connection attempt (`src/main/backends/helperBackend.js`) and talks to it over stdin/stdout. Keeping the SDK out of the Electron process means an SDK crash or hang can't take down the operator UI: the app sees the helper exit and falls back.

- One JSON object per line, UTF-8, `\n` terminated.
- Requests carry an `id`; the response echoes it.
- Events have an `event` field and no `id`.
- Diagnostics go to stderr.
- The helper handles one command at a time. An `upload` blocks until the switcher reports the transfer finished, so transfers can never overlap.

## Requests

| cmd | params | result |
|---|---|---|
| `hello` | | `{ protocol, helperVersion, sdk: "blackmagic"\|"none"\|"mock", sdkAvailable, reason }` |
| `connect` | `transport: "usb"\|"network"`, `address` | snapshot (see below). USB sends an empty address to `IBMDSwitcherDiscovery::ConnectTo`. |
| `state` | | snapshot |
| `prepare` | `path` | `{ cached, ms, cacheBytes }`. Decodes the PNG and converts it to the SDK frame layout ahead of time. |
| `upload` | `stillIndex` (0-based), `path`, `name` | `{ prepared, prepareMs, transferMs }` once the switcher confirms. |
| `disconnect` | | `{}` |
| `shutdown` | | `{}`, then the process exits. Closing stdin does the same. |

Snapshot: `{ width, height, productName, players: [{ sourceType, stillIndex }], stills: [{ used, name }] }`. `sourceType` uses atem-connection's numbering (1 = still, 2 = clip).

Failure response: `{ id, ok: false, code, error }`.

| code | meaning | app retries? |
|---|---|---|
| `sdk_unavailable` | SDK runtime (Blackmagic ATEM Switchers software) missing, or helper built without the SDK | no, tries next connection |
| `connect_failed` | no switcher on that transport | no, tries next connection |
| `not_connected` | upload while disconnected | no |
| `bad_file` | unreadable or not a PNG | no |
| `size_mismatch` | PNG size differs from the switcher's video mode | no |
| `transfer_failed` | switcher reported a failed or cancelled transfer | yes, unless a newer click is waiting |
| `bad_request`, `internal` | programming errors | no |

## Events

| event | fields |
|---|---|
| `connection` | `status: "connected"\|"disconnected"`, `transport?`, `message?` |
| `state` | snapshot fields; sent after SDK callbacks report media pool or media player changes |
| `log` | `message` |

## Pixel handling

PNGs are decoded with stb_image, which applies no gamma and no premultiplication. Channels are only reordered to the layout the SDK frame expects. Already-premultiplied files reach the switcher unchanged.
