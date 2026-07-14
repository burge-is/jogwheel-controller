# Dual DJ example

This two-deck mobile scratch experiment demonstrates two independent `JogWheel` instances controlling an AudioWorklet engine. The DJ controls and audio processing are example code, not part of the JogWheel API.

Audio selected through the file pickers stays in the browser. The development server accepts no uploads and writes no request log.

## Run

From the repository root, install Node.js 18 or newer and run:

```bash
node server.js
```

Open <http://127.0.0.1:8787/examples/dual-dj/> and stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

## Controls

- **Load A / Load B:** choose local audio or a video containing audio.
- **Platter:** scratch forward or backward.
- **Center A / B:** start or brake that deck's motor.
- **Outer vertical control:** choose the seconds covered by one revolution.
- **Link:** one wheel moves both decks by the same time distance.
- **Slip:** keep hidden transport moving while scratching.
- **A–B:** equal-power crossfader; double-click to center it.
- **Rec / Safe:** enable or disable gesture replacement.
- **↻:** replay the remembered gestures over the current audio.
- **···:** adjust layout, platter feel, delay, motor, coast, and resampling.

## Architecture

- `index.html` contains the example interface and styling.
- `app.js` maps generic JogWheel angular events to deck transport positions.
- `scratch-worklet.js` renders the audio trajectory and platter physics.
- The repository-root `server.js` provides static files and cross-origin isolation headers.

The example uses a `SharedArrayBuffer` trajectory ring when cross-origin isolation is available and automatically falls back to ordered MessagePort packets otherwise. GitHub Pages uses the fallback because it cannot set the required response headers.

The example also exposes `window.dualScratch` for diagnostics and deck automation. That object is specific to this example and is not the JogWheel library API.
