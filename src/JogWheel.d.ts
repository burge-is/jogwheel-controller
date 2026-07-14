export interface JogWheelOptions {
  angle?: number;
  deadZone?: number;
  authorityWidth?: number;
  maxDelta?: number;
  velocityWindow?: number;
  maxVelocity?: number;
  keyboard?: boolean;
  keyboardStep?: number;
  preventDefault?: boolean;
}

export interface JogWheelPoint {
  source?: "pointer" | "keyboard";
  timeStamp: number;
  angle: number;
  deltaAngle: number;
  turns: number;
  velocity: number;
  radiusRatio?: number;
  authority: number;
}

export interface JogWheelEventDetail {
  source: "pointer" | "keyboard";
  pointerId?: number;
  timeStamp: number;
  angle: number;
  deltaAngle?: number;
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
  startAngle: number;
  velocity: number;
}

export class JogWheel extends EventTarget {
  constructor(element: Element, options?: JogWheelOptions);
  readonly element: Element;
  readonly options: Readonly<Required<JogWheelOptions>>;
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
