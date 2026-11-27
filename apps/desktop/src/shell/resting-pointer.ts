/**
 * Keeps hover from starting inside `element` under a pointer that has not moved.
 *
 * When something over the element goes away (a drawer's × pressed right above it, a dialog closed with Esc), the
 * browser re-reads what is under the still pointer and sends `mouseenter` and `mousemove` as if the pointer had
 * arrived. A hover card opened by that covers the page the builder was about to use. Those events carry the place
 * of the last real pointer event, so one at the same place as the last pointer event seen outside the element is
 * stopped before the element's children hear it. The first real move, which is at another place, passes.
 *
 * `element` wraps the hover target, so its capturing listeners run before the target's own. Returns the function
 * that removes the listeners.
 */
export function ignoreRestingPointer(element: HTMLElement): () => void {
  const doc = element.ownerDocument;
  let lastOutside: { readonly x: number; readonly y: number } | null = null;

  const track = (event: PointerEvent): void => {
    if (event.target instanceof Node && element.contains(event.target)) {
      // A press on the element itself is the builder's own, wherever the pointer was before.
      if (event.type === 'pointerdown') lastOutside = null;
      return;
    }
    lastOutside = { x: event.clientX, y: event.clientY };
  };
  const stopWhileResting = (event: MouseEvent): void => {
    if (
      lastOutside !== null &&
      event.clientX === lastOutside.x &&
      event.clientY === lastOutside.y
    ) {
      event.stopPropagation();
    }
  };

  doc.addEventListener('pointerdown', track, true);
  doc.addEventListener('pointermove', track, true);
  element.addEventListener('mouseenter', stopWhileResting, true);
  element.addEventListener('mousemove', stopWhileResting, true);
  return () => {
    doc.removeEventListener('pointerdown', track, true);
    doc.removeEventListener('pointermove', track, true);
    element.removeEventListener('mouseenter', stopWhileResting, true);
    element.removeEventListener('mousemove', stopWhileResting, true);
  };
}
