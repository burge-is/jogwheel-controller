# JogWheel

A dependency-free, multi-input gesture controller for the web. Circular mode turns movement around an element into precise angular events. Relative mode turns an invisible full-surface drag into movement and virtual-rotation events. It does not require a visual wheel or assume that the gesture controls audio, video, or any particular UI.

Examples include a [dual-deck scratch lab](./examples/dual-dj/) and a [gesture-only frame scrubber](./examples/video-frame-scrub/).

## Features

- Pointer Events with pointer capture
- Coalesced high-frequency pointer samples
- Circular and visual-free relative gesture modes
- Raw `deltaX` and `deltaY` in relative mode
- Correct angle wrapping across the ±π boundary
- Configurable center dead zone and edge authority
- Smoothed angular velocity and cumulative turns
- Keyboard arrow support
- Multiple independent wheels
- No runtime dependencies

## Quick start

```html
<div id="wheel" aria-label="Jog wheel"></div>
<script type="module">
  import { JogWheel } from "./src/JogWheel.js";

  const element = document.querySelector("#wheel");
  const wheel = new JogWheel(element);

  wheel.addEventListener("move", event => {
    element.style.transform = `rotate(${event.detail.angle}rad)`;
    console.log(event.detail.deltaAngle, event.detail.velocity);
  });
</script>
```

The target element needs a non-zero width and height. `JogWheel` applies `touch-action: none` while active as a controller and restores the original inline value when destroyed.

## Use from Git

Clone or download the repository and import the module directly:

```js
import { JogWheel } from "./src/JogWheel.js";
```

No installation step, package registry, build process, or runtime dependency is required.

## API

### `new JogWheel(element, options?)`

| Option | Default | Meaning |
| --- | ---: | --- |
| `angle` | `0` | Initial cumulative angle in radians |
| `mode` | `"circular"` | `"circular"` or visual-free `"relative"` tracking |
| `axis` | `"x"` | Relative mode's virtual-rotation axis: `"x"` or `"y"` |
| `radiansPerPixel` | `2π / 360` | Relative-mode conversion from pixels to virtual radians |
| `deadZone` | `0.25` | Circular mode's ignored center-radius ratio |
| `authorityWidth` | `0.2` | Soft transition from the dead zone to full movement |
| `maxDelta` | `1.1` | Maximum radians accepted from one pointer sample |
| `velocityWindow` | `0.062` | Velocity fitting window in seconds |
| `maxVelocity` | `80` | Maximum reported radians per second |
| `keyboard` | `true` | Enable arrow-key control and automatic `tabindex` |
| `keyboardStep` | `π / 36` | Radians moved by one arrow-key event |
| `preventDefault` | `true` | Prevent native pointer movement behavior |
| `filter` | `null` | Optional function that decides whether a pointer gesture may start |

### Events

Listen on the controller for `start`, `move`, and `end`:

```js
wheel.addEventListener("move", ({ detail }) => {
  const { angle, deltaAngle, gestureAngle, turns, velocity, points } = detail;
});
```

The target element also emits bubbling `jogwheel:start`, `jogwheel:move`, and `jogwheel:end` events. Angles are radians and velocity is radians per second. `move.detail.points` preserves coalesced pointer samples. Relative events additionally include raw CSS-pixel `deltaX` and `deltaY` values.

### Methods and properties

- `wheel.angle` — current cumulative angle
- `wheel.active` — active pointer state, or `null`
- `wheel.setAngle(radians)` — replace the cumulative angle
- `wheel.destroy()` — remove listeners and restore modified element state

## Visual-free relative gestures

Use the entire surface without rendering a wheel:

```js
const gesture = new JogWheel(videoSurface, {
  mode: "relative",
  axis: "x"
});

gesture.addEventListener("move", ({ detail }) => {
  timeline.moveBy(detail.deltaX);
});
```

## Mapping rotation to media

Media behavior belongs in the consuming application:

```js
const secondsPerRevolution = 1.8;
wheel.addEventListener("move", ({ detail }) => {
  const deltaSeconds = detail.deltaAngle / (Math.PI * 2) * secondsPerRevolution;
  player.seekBy(deltaSeconds);
});
```

## Examples

```bash
node server.js
```

- Example selection: <http://127.0.0.1:8787/>
- Dual DJ: <http://127.0.0.1:8787/examples/dual-dj/>
- Gesture-only video frame scrubber: <http://127.0.0.1:8787/examples/video-frame-scrub/>

Open the dual DJ example to try audio scratching. Audio selected in the example stays in the browser and is not uploaded. The local server supplies isolation headers for the example's optional `SharedArrayBuffer` fast path.

GitHub Pages can host the static example, but it cannot provide those headers; the audio example automatically uses its MessagePort fallback. The jogwheel library itself does not require `SharedArrayBuffer` or Node.

## Development

```bash
node --test
node --check src/JogWheel.js
```

The library targets modern browsers with Pointer Events and ES modules.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidance. Please use the repository host's private security-advisory feature for vulnerability reports rather than a public issue.

## License

[MIT](./LICENSE)
