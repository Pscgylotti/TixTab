import { describe, it, expect } from 'vitest';
import { ScrollVelocity, inertiaStep } from './scrollInertia';
describe('touch inertia', () => {
  it('uses recent movement, clamps speed, and does not fling after a pause', () => {
    const v = new ScrollVelocity();
    v.add(10, 600, 0);
    v.add(10, 550, 20);
    v.add(10, 450, 40);
    expect(v.release(45)).toEqual({ x: 0, y: 3 });
    expect(v.release(130)).toEqual({ x: 0, y: 0 });
    v.reset();
    expect(v.release(200)).toEqual({ x: 0, y: 0 });
  });
  it('decays consistently across frame rates and stops at low speed', () => {
    let speed = { x: 0, y: 2 },
      distance = 0;
    for (let i = 0; i < 60; i++) {
      const next = inertiaStep(speed, 16.6666667);
      distance += next.dy;
      speed = next.velocity;
    }
    let slow = { x: 0, y: 2 },
      distance30 = 0;
    for (let i = 0; i < 30; i++) {
      const next = inertiaStep(slow, 33.3333333);
      distance30 += next.dy;
      slow = next.velocity;
    }
    expect(distance).toBeCloseTo(distance30, 3);
    expect(distance).toBeGreaterThan(500);
    expect(inertiaStep({ x: 0, y: 0.01 }, 16).done).toBe(true);
    expect(inertiaStep({ x: 0, y: 2 }, 500).dy).toBeLessThan(80);
  });
});
