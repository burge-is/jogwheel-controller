import { TAU, clamp, fitVelocity, wrapAngle } from "./math.js";

const DEFAULTS = Object.freeze({
  deadZone: 0.25,
  authorityWidth: 0.2,
  maxDelta: 1.1,
  velocityWindow: 0.062,
  maxVelocity: 80,
  keyboard: true,
  keyboardStep: Math.PI / 36,
  preventDefault: true
});

/**
 * Turns any circular DOM element into a dependency-free jogwheel controller.
 * The controller reports radians only; mapping rotation to media is up to the
 * consuming application.
 */
export class JogWheel extends EventTarget {
  constructor(element, options = {}) {
    super();
    if (!(element instanceof Element)) throw new TypeError("JogWheel requires a DOM Element");

    this.element = element;
    this.options = { ...DEFAULTS, ...options };
    this.angle = Number(options.angle) || 0;
    this.active = null;
    this.destroyed = false;

    this._previousTouchAction = element.style.touchAction;
    this._addedTabIndex = false;
    element.style.touchAction = "none";
    if (this.options.keyboard && !element.hasAttribute("tabindex")) {
      element.tabIndex = 0;
      this._addedTabIndex = true;
    }

    this._onPointerDown = event => this._pointerDown(event);
    this._onPointerMove = event => this._pointerMove(event);
    this._onPointerEnd = event => this._pointerEnd(event);
    this._onKeyDown = event => this._keyDown(event);

    element.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("pointermove", this._onPointerMove, { passive: false });
    window.addEventListener("pointerup", this._onPointerEnd);
    window.addEventListener("pointercancel", this._onPointerEnd);
    if (this.options.keyboard) element.addEventListener("keydown", this._onKeyDown);
  }

  setAngle(angle) {
    if (!Number.isFinite(angle)) throw new TypeError("angle must be a finite number");
    this.angle = angle;
    return this;
  }

  _polar(event) {
    const rect = this.element.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    return {
      angle: Math.atan2(dy, dx),
      radiusRatio: Math.hypot(dx, dy) / Math.max(1, Math.min(rect.width, rect.height) / 2)
    };
  }

  _pointerDown(event) {
    if (this.destroyed || this.active || (event.button != null && event.button !== 0)) return;
    const point = this._polar(event);
    if (point.radiusRatio < this.options.deadZone) return;
    if (this.options.preventDefault) event.preventDefault();

    const time = event.timeStamp / 1000;
    this.active = {
      pointerId: event.pointerId,
      previousAngle: point.angle,
      samples: [{ time, value: this.angle }],
      startAngle: this.angle,
      velocity: 0
    };
    this.element.setPointerCapture?.(event.pointerId);
    this._emit("start", {
      source: "pointer",
      pointerId: event.pointerId,
      timeStamp: event.timeStamp,
      angle: this.angle,
      turns: this.angle / TAU,
      radiusRatio: point.radiusRatio
    });
  }

  _pointerMove(event) {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    if (this.options.preventDefault) event.preventDefault();

    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const sourcePoints = coalesced.length ? coalesced : [event];
    const points = [];
    let totalDelta = 0;

    for (const source of sourcePoints) {
      const polar = this._polar(source);
      if (polar.radiusRatio < this.options.deadZone) {
        active.previousAngle = polar.angle;
        continue;
      }

      const authority = clamp(
        (polar.radiusRatio - this.options.deadZone) / Math.max(1e-6, this.options.authorityWidth),
        0,
        1
      );
      const deltaAngle = clamp(
        wrapAngle(polar.angle - active.previousAngle) * authority,
        -this.options.maxDelta,
        this.options.maxDelta
      );
      active.previousAngle = polar.angle;
      this.angle += deltaAngle;
      totalDelta += deltaAngle;

      const time = source.timeStamp / 1000;
      active.samples.push({ time, value: this.angle });
      active.samples = active.samples.filter(sample => time - sample.time <= this.options.velocityWindow);
      active.velocity = fitVelocity(active.samples, this.options.maxVelocity);
      points.push({
        timeStamp: source.timeStamp,
        angle: this.angle,
        deltaAngle,
        turns: this.angle / TAU,
        velocity: active.velocity,
        radiusRatio: polar.radiusRatio,
        authority
      });
    }

    if (!points.length) return;
    this._emit("move", {
      source: "pointer",
      pointerId: event.pointerId,
      timeStamp: event.timeStamp,
      angle: this.angle,
      deltaAngle: totalDelta,
      gestureAngle: this.angle - active.startAngle,
      turns: this.angle / TAU,
      velocity: active.velocity,
      points
    });
  }

  _pointerEnd(event) {
    const active = this.active;
    if (!active || event.pointerId !== active.pointerId) return;
    this.element.releasePointerCapture?.(event.pointerId);
    this.active = null;
    this._emit("end", {
      source: "pointer",
      pointerId: event.pointerId,
      timeStamp: event.timeStamp,
      angle: this.angle,
      gestureAngle: this.angle - active.startAngle,
      turns: this.angle / TAU,
      velocity: active.velocity,
      cancelled: event.type === "pointercancel"
    });
  }

  _keyDown(event) {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? 1
        : 0;
    if (!direction) return;
    event.preventDefault();
    const deltaAngle = direction * this.options.keyboardStep;
    const startAngle = this.angle;
    const common = { source: "keyboard", timeStamp: event.timeStamp };
    this._emit("start", { ...common, angle: startAngle, turns: startAngle / TAU });
    this.angle += deltaAngle;
    this._emit("move", {
      ...common,
      angle: this.angle,
      deltaAngle,
      gestureAngle: deltaAngle,
      turns: this.angle / TAU,
      velocity: 0,
      points: [{ ...common, angle: this.angle, deltaAngle, turns: this.angle / TAU, velocity: 0, authority: 1 }]
    });
    this._emit("end", { ...common, angle: this.angle, gestureAngle: deltaAngle, turns: this.angle / TAU, velocity: 0, cancelled: false });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    this.element.dispatchEvent(new CustomEvent(`jogwheel:${type}`, { detail, bubbles: true }));
  }

  destroy() {
    if (this.destroyed) return;
    if (this.active) {
      this.element.releasePointerCapture?.(this.active.pointerId);
      this.active = null;
    }
    this.element.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerEnd);
    window.removeEventListener("pointercancel", this._onPointerEnd);
    this.element.removeEventListener("keydown", this._onKeyDown);
    this.element.style.touchAction = this._previousTouchAction;
    if (this._addedTabIndex) this.element.removeAttribute("tabindex");
    this.destroyed = true;
  }
}

export default JogWheel;
