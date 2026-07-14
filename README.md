# JogWheel

A dependency-free, multi-input jogwheel controller for the web. It converts pointer or keyboard movement around a circular element into precise angular events. It does not assume that the wheel controls audio, video, or any particular UI.

The included [dual-deck scratch lab](./examples/dual-dj/) is an advanced usage example, not part of the library API.

## Features

- Pointer Events with pointer capture
- Coalesced high-frequency pointer samples
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
| `deadZone` | `0.25` | Ignored center radius, as a wheel-radius ratio |
| `authorityWidth` | `0.2` | Soft transition from the dead zone to full movement |
| `maxDelta` | `1.1` | Maximum radians accepted from one pointer sample |
| `velocityWindow` | `0.062` | Velocity fitting window in seconds |
| `maxVelocity` | `80` | Maximum reported radians per second |
| `keyboard` | `true` | Enable arrow-key control and automatic `tabindex` |
| `keyboardStep` | `π / 36` | Radians moved by one arrow-key event |
| `preventDefault` | `true` | Prevent native pointer movement behavior |

### Events

Listen on the controller for `start`, `move`, and `end`:

```js
wheel.addEventListener("move", ({ detail }) => {
  const { angle, deltaAngle, gestureAngle, turns, velocity, points } = detail;
});
```

The target element also emits bubbling `jogwheel:start`, `jogwheel:move`, and `jogwheel:end` events. Angles are radians and velocity is radians per second. `move.detail.points` preserves coalesced pointer samples.

### Methods and properties

- `wheel.angle` — current cumulative angle
- `wheel.active` — active pointer state, or `null`
- `wheel.setAngle(radians)` — replace the cumulative angle
- `wheel.destroy()` — remove listeners and restore modified element state

## Mapping rotation to media

Media behavior belongs in the consuming application:

```js
const secondsPerRevolution = 1.8;
wheel.addEventListener("move", ({ detail }) => {
  const deltaSeconds = detail.deltaAngle / (Math.PI * 2) * secondsPerRevolution;
  player.seekBy(deltaSeconds);
});
```

## Dual DJ example

```bash
node server.js
```

Open <http://127.0.0.1:8787/>. Audio selected in the example stays in the browser and is not uploaded. The local server supplies isolation headers for the example's optional `SharedArrayBuffer` fast path.

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
