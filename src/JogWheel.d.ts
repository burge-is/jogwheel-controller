export interface JogWheelOptions {
  angle?: number;
  mode?: "circular" | "platter" | "relative";
  axis?: "x" | "y";
  radiansPerPixel?: number;
  platterRadius?: number;
  deadZone?: number;
  authorityWidth?: number;
  maxDelta?: number;
  velocityWindow?: number;
  maxVelocity?: number;
  keyboard?: boolean;
  keyboardStep?: number;
  preventDefault?: boolean;
  filter?: ((event: PointerEvent) => boolean) | null;
}

export interface JogWheelPoint {
  source?: "pointer" | "keyboard";
  mode?: "circular" | "platter" | "relative";
  timeStamp: number;
  angle: number;
  deltaAngle: number;
  deltaX: number;
  deltaY: number;
  turns: number;
  velocity: number;
  radiusRatio?: number;
  authority: number;
}

export interface JogWheelEventDetail {
  source: "pointer" | "keyboard";
  mode: "circular" | "platter" | "relative";
  pointerId?: number;
  timeStamp: number;
  angle: number;
  deltaAngle?: number;
  deltaX?: number;
  deltaY?: number;
  gestureAngle?: number;
  turns: number;
  velocity?: number;
  radiusRatio?: number;
  points?: JogWheelPoint[];
  cancelled?: boolean;
}

export interface JogWheelActiveState {
  pointerId: number;
  previousAngle: number;
  previousX: number;
  previousY: number;
  virtualX: number;
  virtualY: number;
  platterRadius: number;
  startAngle: number;
  velocity: number;
}

export class JogWheel extends EventTarget {
  constructor(element: Element, options?: JogWheelOptions);
  readonly element: Element;
  readonly options: JogWheelOptions;
  angle: number;
  readonly active: JogWheelActiveState | null;
  readonly destroyed: boolean;
  setAngle(angle: number): this;
  destroy(): void;
  addEventListener(
    type: "start" | "move" | "end",
    listener: (event: CustomEvent<JogWheelEventDetail>) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
}

export default JogWheel;
