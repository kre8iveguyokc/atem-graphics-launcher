# Hardware test checklist (before first live use)

About 15 minutes with the ATEM Mini Extreme ISO, a monitor on the program or multiview output, and the laptop that will run the show. Do it once per laptop type (Mac and Windows).

Fill in the result column and keep this with the show notes.

## Setup

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Connect laptop to the ATEM by Ethernet. Open the app (live mode, no orange banner). | Pill turns green: **Connected · IP**. | |
| 2 | In ATEM Software Control set MP1 → Still 1, MP2 → Still 2. | No yellow warning bar in the app. | |
| 3 | Set MP1 to Still 5 in ATEM Software Control. | App shows **Check the switcher: Media Player 1 is on Still 5**. Set it back; warning clears. | |
| 4 | Choose the show folder. | Thumbnails appear; footer reaches **Ready: N pre-encoded**. | |

## Uploads (key off air)

| # | Step | Expected | Result |
|---|---|---|---|
| 5 | Slot 1 selected, click a graphic. | **On slot ✓** with a time. ATEM Software Control media pool Still 1 shows the new image and its file name. | Time: |
| 6 | Put the DSK on preview / check the multiview. | Graphic appears with clean edges and correct transparency (premultiplied). | |
| 7 | Slot 2, click a different graphic. | Still 2 changes; Still 1 unchanged. | |
| 8 | Click 5 graphics fast on Slot 1. | Only the first and the last upload. Still 1 ends on the last one clicked. | |
| 9 | Click your largest (most opaque) graphic. | Uploads; note the time. | Time: |

## On air

| # | Step | Expected | Result |
|---|---|---|---|
| 10 | Key MP1 on air. Click a new graphic for Slot 1. | Image changes on program when the transfer finishes. Note any flash, tear, black frame or partial image. | |
| 11 | Repeat 10 several times. | Consistent behaviour. | |

## Failure handling

| # | Step | Expected | Result |
|---|---|---|---|
| 12 | Unplug the Ethernet cable. | Pill turns amber/red within a few seconds. Clicking shows an error, nothing hangs. | |
| 13 | Plug it back in. | Reconnects on its own; uploads work again. | |
| 14 | Upload from ATEM Software Control and click in the app at the same time. | Both finish, or the app reports an error and works on the next click. | |
| 15 | Confirm the app changed nothing else (program/preview, keyers, transitions, MP assignments). | Nothing changed. | |

## USB-C / Blackmagic SDK

Check the pill: it should name the connection in use. Repeat steps 5–11 on USB as well as Ethernet.

| # | Step | Expected | Result |
|---|---|---|---|
| 16 | ATEM Software Control 11.0 or newer installed. Connect **only** USB-C, clear the IP in Settings. | Pill: **Connected · USB · Blackmagic SDK**. | |
| 17 | Steps 5–11 over USB. | Same results as Ethernet. Note transfer times. | USB time: |
| 18 | Connect USB and Ethernet, IP set. | USB is used. | |
| 19 | Unplug USB while Ethernet is connected. | Within a few seconds: **Connected · Ethernet · Blackmagic SDK**. Clicking still works. | |
| 20 | Plug USB back in, then unplug Ethernet briefly. | App returns to USB. | |
| 21 | On a laptop **without** ATEM Software Control, Ethernet connected. | Falls back to **Ethernet · atem-connection**; uploads work. | |
| 22 | ATEM Software Control's Media page open during uploads. | Uploads succeed; no lock errors left behind. | |

If 10 shows a visible glitch, the workaround is to take the key off air before clicking. Report results so the README's verification table can be updated.
