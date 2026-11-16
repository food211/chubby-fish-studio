# 肥鱼画室 / Chubby fish studio

The Mixbox Palette panel as a DSH surface: a pigment-mixing painting canvas in the
right sidebar, plus the three tools that let an agent look at it and paint on it.

## What it does

- **Canvas panel** — the right sidebar gains a `Mixbox Palette` tab type and a guide
  card. The tab hosts the KM pigment-mixing engine (a 32×32×320 spectral LUT sampled
  in WebGL2) with the app's brushes, watercolour wet-paper and drip passes, palettes,
  pressure support, zoom and undo history.
- **The agent can see it** — `canvas_look` returns the current picture as an image
  block together with the canvas pixel size, brush, palette, colours and undo
  position. `canvas_state` returns the same facts without a picture.
- **The agent can paint** — `canvas_draw` paints strokes through the same
  `drawBrush` pipeline the user paints with, so its pigment mixes, it responds to
  paper wetness, and every stroke lands in the same undo stack. `canvas_look` after a
  drawing call shows the result.
- **Canvas size is an explicit setting** — the ⚙ chip at the top of the panel opens a
  size dialog: a slider and a number field over the app's own range, 480–1000 logical
  width (680×572 up to 1417×1192 px). Applying it runs the app's resize path, so the
  painting is resampled, the undo history resets, and the width is remembered for the
  next open. The panel does not follow the window or the sidebar width; the size you
  set is the size you get. The upstream edge-drag handles and the desktop-host
  "shortcuts are captured" bar are removed.

A canvas chip sits in the composer dock to open the panel. The panel's own app
(`D:\image\2022\同人\mixbox-palette`) keeps its internal language switch, brush
controls and instructions panel.

## Using it

1. Open the `Canvas` chip above the composer, or **Plugins**-style guide card
   `Mixbox Palette` in the right sidebar.
2. Paint as usual. The panel pushes a downscaled snapshot to the host when a stroke
   ends (debounced), so the next `canvas_look` sees what is on the canvas.
3. Ask the agent about the painting, or ask it to demonstrate something. Say
   "look at my painting" and it calls `canvas_look`.

## Limits

- **Snapshots are pull-based.** The agent sees the canvas only when a tool runs; it
  cannot watch while you paint. Each look costs one image in the context.
- **One canvas per page.** The panel is a single instance; opening it in another
  session re-scopes persistence to that session and reloads its saved snapshot.
- **The canvas is not in the session log.** Agent strokes are recorded in tool
  arguments and can be replayed, but your own hand-painted strokes live in the
  panel's `localStorage` scope (`mpx:<sessionId>:`), so forking a session does not
  rewind the canvas.
- **The bridge is loopback HTTP.** The panel posts snapshots to `/mpx/canvas/push`
  and listens on `/mpx/canvas/stream`; both routes are registered by this plugin and
  are reachable from the local GUI origin only. There is no per-request
  authentication beyond that origin.
- **KM engine only.** The bundled panel ships the custom KM renderer; the Mixbox
  engine, the desktop host bridge, the updater, the announcement modal and the
  service worker from the upstream app are not part of this bundle.
- **Not themed by the host.** The panel keeps the app's own dark panel styling
  because it is a painting surface, not host chrome. Its buttons use the app's own
  language switch rather than the DSH locale service.
- **Pressure needs a pen.** Pointer pressure comes from the browser; verify with a
  drawing tablet before relying on it.

## Rebuilding the client half

`client.js` is generated from the upstream checkout:

```sh
node build/build-client.mjs --src "D:\image\2022\同人\mixbox-palette"
```

The script fails loudly if a patch target moves in the upstream sources.
