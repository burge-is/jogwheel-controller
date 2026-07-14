# Gesture-only video frame scrubber

This example has no visible wheel. A `JogWheel` instance in `relative` mode turns the entire video surface into a horizontal gesture controller.

- One CSS pixel of horizontal movement requests one video frame.
- Left and right arrow keys request one frame.
- The requested and actually presented frame numbers are shown separately.
- The video remains local to the browser.

Run `node server.js` from the repository root, open <http://127.0.0.1:8787/examples/video-frame-scrub/>, load a video, and enter its frame rate.

HTML video does not expose a video's source frame rate, so the FPS value must be supplied by the user. `requestVideoFrameCallback` reports the frame the browser actually presents. Exact seek latency still depends on browser decoding and the video's keyframe structure; for guaranteed codec-level random frame decoding, an application would need a WebCodecs-based decoder.
