# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

- Added visual-free relative gesture mode with raw pointer movement deltas.
- Added a full-screen invisible-platter video example with one-degree-per-frame rotation and release coasting.
- Frame-locked video seeking keeps the requested and presented positions within one frame while decoding.
- Stationary taps stop platter coasting or toggle video play/pause.

## 1.0.0

- Initial public JogWheel API.
- Pointer capture, coalesced events, dead-zone authority, angle wrapping, velocity estimation, and keyboard input.
- Dual DJ AudioWorklet example.
