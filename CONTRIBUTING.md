# Contributing

Bug reports, documentation fixes, tests, and focused pull requests are welcome.

## Development

Requires Node.js 18 or newer.

```bash
node --test
node --check src/JogWheel.js
node server.js
```

Keep the core library independent of the dual DJ example. Generic pointer, rotation, velocity, and accessibility behavior belongs in `src/`; audio and deck behavior belongs in `examples/dual-dj/`.

Before opening a pull request, include tests for reusable math or behavior where practical and confirm that the dual DJ example still works with mouse, touch, and pen input.
