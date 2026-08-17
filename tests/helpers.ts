import type { ScreenSnapshot, ScreenSize, UiElement } from "../src/core/types.js";
import { centerOf } from "../src/core/coords.js";

export const SCREEN: ScreenSize = { width: 393, height: 852, scale: 3 };

export interface ElementSpec {
  role: string;
  label?: string;
  value?: string;
  placeholder?: string;
  identifier?: string;
  /** Relative 0–1000 box. */
  rect: [number, number, number, number];
  enabled?: boolean;
  nativeType?: string;
  children?: ElementSpec[];
}

export function element(spec: ElementSpec, id = "0"): UiElement {
  const rect = { x: spec.rect[0], y: spec.rect[1], width: spec.rect[2], height: spec.rect[3] };
  return {
    id,
    role: spec.role,
    nativeType: spec.nativeType ?? spec.role,
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.value !== undefined ? { value: spec.value } : {}),
    ...(spec.placeholder !== undefined ? { placeholder: spec.placeholder } : {}),
    ...(spec.identifier !== undefined ? { identifier: spec.identifier } : {}),
    rect,
    center: centerOf(rect),
    enabled: spec.enabled ?? true,
    children: (spec.children ?? []).map((child, index) => element(child, `${id}.${index}`)),
  };
}

export function snapshot(specs: ElementSpec[]): ScreenSnapshot {
  const elements = specs.map((spec, index) => element(spec, String(index)));
  return {
    platform: "ios",
    deviceId: "test-device",
    screen: SCREEN,
    elements,
    stats: { rawNodes: elements.length, keptNodes: elements.length },
  };
}
