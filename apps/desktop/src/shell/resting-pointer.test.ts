import { expect, it } from 'vitest';
import { ignoreRestingPointer } from './resting-pointer';

/** A mouse or pointer event at a place in the window. */
function at(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { clientX: x, clientY: y, bubbles: type !== 'mouseenter' });
}

it('keeps a pointer left resting over the target from starting hover, until it moves', () => {
  const wrapper = document.createElement('span');
  const target = wrapper.appendChild(document.createElement('button'));
  const closeButton = document.createElement('button');
  document.body.append(wrapper, closeButton);
  const heard: string[] = [];
  for (const type of ['mouseenter', 'mousemove']) {
    target.addEventListener(type, () => heard.push(type));
  }
  const stop = ignoreRestingPointer(wrapper);

  // A press on a drawer's × that sits over the target; the drawer leaves and the browser reports the still
  // pointer as entering the target, at the place of the press.
  closeButton.dispatchEvent(at('pointerdown', 1255, 30));
  target.dispatchEvent(at('mouseenter', 1255, 30));
  target.dispatchEvent(at('mousemove', 1255, 30));
  expect(heard).toEqual([]);

  // The pointer really moves, on the target and then onto it from elsewhere.
  target.dispatchEvent(at('mousemove', 1256, 30));
  closeButton.dispatchEvent(at('pointermove', 900, 300));
  target.dispatchEvent(at('mouseenter', 1250, 28));
  expect(heard).toEqual(['mousemove', 'mouseenter']);

  // A press on the target itself is the builder's own, even where the pointer last rested.
  closeButton.dispatchEvent(at('pointermove', 1255, 30));
  target.dispatchEvent(at('pointerdown', 1255, 30));
  target.dispatchEvent(at('mouseenter', 1255, 30));
  expect(heard).toEqual(['mousemove', 'mouseenter', 'mouseenter']);

  stop();
  wrapper.remove();
  closeButton.remove();
});
