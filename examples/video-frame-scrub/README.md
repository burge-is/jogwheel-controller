# Invisible-jogwheel video frame scrubber

This example renders no wheel, but retains jogwheel mechanics. The full-screen video surface acts as a platter centered on the screen:

- Move in an arc around the screen center to turn the invisible platter.
- Angular direction and distance control frame direction and distance.
- One degree of platter rotation requests one video frame.
- A quick release coasts using the measured angular velocity and platter drag.
- Left and right arrow keys request one frame.
- Requested and actually presented frame numbers are shown separately.
- The video remains local to the browser.

Run `node server.js` from the repository root, open <http://127.0.0.1:8787/examples/video-frame-scrub/>, load a video, and enter its frame rate.

HTML video does not expose a video's source frame rate, so the FPS value must be supplied by the user. `requestVideoFrameCallback` reports the frame the browser actually presents. Exact seek latency still depends on browser decoding and the video's keyframe structure; guaranteed codec-level random frame decoding would require a WebCodecs-based decoder.
