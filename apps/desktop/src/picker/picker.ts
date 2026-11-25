// Pick on Page spec §3: pick mode in the page. The pill (or ⌘⇧C) toggles it; hover outlines, a click
// picks one element and opens its note, ⇧-click adds an element to the newest pick, a drag picks an area,
// ⌥ held hands the page back. A saved note sends the pick to the shell, which crops it and hands it to
// the page's draft in 10db; nothing here sends a message.

import type { PickKind as Kind, PickRect } from '@10db/contracts';
import { getElementAtPoint, isElementGrabbable } from 'react-grab/primitives';
import { channel, refusalOf } from './channel';
import { createOverlay, place, type Overlay } from './overlay';
import { boxOf, describe, elementTitle, type PagePickInput, type PickElementInput } from './pick';

export interface PickerConfig {
  readonly repoPath: string;
}

interface Pick {
  readonly id: string;
  kind: PickKind;
  readonly elements: Element[];
  readonly described: Map<Element, Promise<PickElementInput>>;
  /** An area pick's box, in page coordinates, so it follows the scroll. */
  area: PickRect | null;
  note: string;
}

// The limits and kinds `@10db/contracts` names (`PAGE_PICKS_MAX`, `PAGE_PICK_ELEMENTS_MAX`, `PickKind`),
// written here because the page's script takes only its types: its values would bundle zod into every
// page. The shell and the UI check each of them again.
const PAGE_PICKS_MAX = 8;
const PAGE_PICK_ELEMENTS_MAX = 6;
const PickKind = { Element: 'element', Group: 'group', Area: 'area' } as const satisfies Record<
  string,
  Kind
>;
type PickKind = Kind;

const DRAG_START_PX = 6;
/** How long a save waits for a slow source lookup before sending what it has. */
const LOOKUP_WAIT_MS = 1_500;

const newId = (): string =>
  `pk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const sleep = (ms: number) =>
  new Promise<null>((resolve) =>
    setTimeout(() => {
      resolve(null);
    }, ms),
  );

const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resolve();
      }),
    ),
  );

export function startPicker(config: PickerConfig): void {
  const ui: Overlay = createOverlay();
  const picks: Pick[] = [];
  let picking = false;
  let passthrough = false;
  let open: Pick | null = null;
  let page: string | null = null;
  let drag: {
    x: number;
    y: number;
    moved: boolean;
    shift: boolean;
    target: Element | null;
  } | null = null;
  let noticeTimer = 0;

  const ours = (node: EventTarget | null) => node === ui.host;
  const grabbable = (candidate: Element) => !ours(candidate) && isElementGrabbable(candidate);
  const at = (x: number, y: number) => getElementAtPoint(x, y, { filter: grabbable });

  void channel.target().then((name) => {
    page = name;
    render();
  });

  function say(message: string) {
    ui.notice.textContent = message;
    ui.notice.style.display = 'block';
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (ui.notice.style.display = 'none'), 4_000);
  }

  function setPicking(on: boolean) {
    picking = on;
    if (!on) {
      ui.hover.style.display = 'none';
      closeNote();
    }
    render();
  }

  const scrollBox = (r: PickRect): PickRect => ({
    ...r,
    x: r.x - window.scrollX,
    y: r.y - window.scrollY,
  });

  function boxesOf(pick: Pick): PickRect[] {
    return pick.area === null ? pick.elements.map(boxOf) : [scrollBox(pick.area)];
  }

  function render() {
    ui.pill.classList.toggle('picking', picking);
    ui.pill.classList.toggle('has', picks.length > 0);
    ui.pillCount.textContent =
      picks.length === 0
        ? 'click an element'
        : `${String(picks.length)} pick${picks.length === 1 ? '' : 's'}`;
    ui.pillSend.textContent = `${String(picks.length)} in ${page ?? '10db'} ›`;
    ui.marks.replaceChildren();
    picks.forEach((pick, index) => {
      boxesOf(pick).forEach((r, i) => {
        const box = document.createElement('div');
        box.className = pick.kind === PickKind.Element ? 'box' : 'box group';
        place(box, r);
        ui.marks.appendChild(box);
        if (i > 0) return;
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.dataset['pick'] = pick.id;
        badge.textContent = String(index + 1);
        badge.style.left = `${String(r.x)}px`;
        badge.style.top = `${String(r.y)}px`;
        badge.addEventListener('click', (event) => {
          event.stopPropagation();
          openNote(pick);
        });
        ui.marks.appendChild(badge);
      });
    });
  }

  function sourceLine(pick: Pick, first: PickElementInput | null): string {
    if (pick.kind === PickKind.Area && pick.elements.length === 0) return 'Area';
    const where =
      first?.source == null ? '' : ` · ${first.source.file}:${String(first.source.line)}`;
    const name = first?.component ?? first?.tag ?? '';
    return pick.elements.length > 1
      ? `${String(pick.elements.length)} elements · ${name}`
      : `${name}${where}`;
  }

  function openNote(pick: Pick) {
    open = pick;
    const boxes = boxesOf(pick);
    const anchor = boxes[boxes.length - 1] ?? { x: 16, y: 16, width: 0, height: 0 };
    let left = anchor.x + anchor.width + 12;
    let top = anchor.y - 6;
    if (left + 304 > window.innerWidth) {
      left = Math.min(anchor.x, window.innerWidth - 312);
      top = anchor.y + anchor.height + 8;
      if (top + 130 > window.innerHeight) top = anchor.y - 128;
    }
    ui.note.style.left = `${String(Math.max(8, left))}px`;
    ui.note.style.top = `${String(Math.max(8, top))}px`;
    ui.note.style.display = 'block';
    ui.noteNumber.textContent = String(picks.indexOf(pick) + 1);
    ui.noteSource.textContent = sourceLine(pick, null);
    const first = pick.elements[0];
    const lookup = first === undefined ? undefined : pick.described.get(first);
    void lookup?.then((d) => {
      if (open === pick) ui.noteSource.textContent = sourceLine(pick, d);
    });
    ui.noteText.value = pick.note;
    ui.noteText.focus();
    ui.hover.style.display = 'none';
  }

  function closeNote() {
    const pick = open;
    if (pick === null) return;
    pick.note = ui.noteText.value.trim();
    open = null;
    ui.note.style.display = 'none';
    ui.note.classList.remove('faded');
    void send(pick);
  }

  async function send(pick: Pick) {
    // The crop is WebKit's picture of the page as painted: the note and the hover box are hidden first.
    await nextFrame();
    const elements = await Promise.all(
      pick.elements.map((element) =>
        Promise.race([
          pick.described.get(element) ?? describe(element, config.repoPath),
          sleep(LOOKUP_WAIT_MS),
        ]).then((described) => described ?? describe(element, config.repoPath)),
      ),
    );
    const input: PagePickInput = {
      id: pick.id,
      kind: pick.kind,
      elements: elements.map((e, i) => {
        const element = pick.elements[i];
        return element === undefined ? e : { ...e, rect: boxOf(element) };
      }),
      area: pick.area === null ? null : scrollBox(pick.area),
      note: pick.note.slice(0, 2_000),
      route: `${location.pathname}${location.search}`.slice(0, 512),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
      engine: 'WebKit',
    };
    try {
      page = (await channel.add(input)) ?? page;
    } catch (error) {
      say(refusalOf(error));
    }
    render();
  }

  function remove(pick: Pick) {
    const index = picks.indexOf(pick);
    if (index >= 0) picks.splice(index, 1);
    if (open === pick) {
      open = null;
      ui.note.style.display = 'none';
    }
    void channel.remove(pick.id).catch(() => undefined);
    render();
  }

  function track(pick: Pick, element: Element) {
    pick.elements.push(element);
    pick.described.set(element, describe(element, config.repoPath));
  }

  function pickElement(element: Element, shift: boolean) {
    const newest = picks[picks.length - 1];
    if (shift && newest !== undefined) {
      if (!newest.elements.includes(element) && newest.elements.length < PAGE_PICK_ELEMENTS_MAX) {
        track(newest, element);
        newest.kind = PickKind.Group;
        newest.area = null;
      }
      openNote(newest);
      render();
      return;
    }
    if (picks.length >= PAGE_PICKS_MAX) {
      say(`${String(PAGE_PICKS_MAX)} picks is the most one message takes`);
      return;
    }
    const pick: Pick = {
      id: newId(),
      kind: PickKind.Element,
      elements: [],
      described: new Map(),
      area: null,
      note: '',
    };
    track(pick, element);
    picks.push(pick);
    openNote(pick);
    render();
  }

  function pickArea(x0: number, y0: number, x1: number, y1: number) {
    if (picks.length >= PAGE_PICKS_MAX) {
      say(`${String(PAGE_PICKS_MAX)} picks is the most one message takes`);
      return;
    }
    const box = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };
    const inside = [...document.body.querySelectorAll('*')].filter((candidate) => {
      if (!grabbable(candidate)) return false;
      const r = candidate.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.left >= box.x &&
        r.top >= box.y &&
        r.right <= box.x + box.width &&
        r.bottom <= box.y + box.height
      );
    });
    const outermost = inside.filter((e) => !inside.some((o) => o !== e && o.contains(e)));
    const pick: Pick = {
      id: newId(),
      kind: PickKind.Area,
      elements: [],
      described: new Map(),
      area: { ...box, x: box.x + window.scrollX, y: box.y + window.scrollY },
      note: '',
    };
    for (const element of outermost.slice(0, PAGE_PICK_ELEMENTS_MAX)) track(pick, element);
    picks.push(pick);
    openNote(pick);
    render();
  }

  function showHover(element: Element) {
    const r = boxOf(element);
    place(ui.hover, r);
    ui.hover.style.display = 'block';
    ui.tag.classList.toggle('below', r.y < 28);
    const title = document.createElement('span');
    title.textContent = elementTitle(element);
    ui.tag.replaceChildren(title);
    void describe(element, config.repoPath).then((d) => {
      if (ui.hover.style.display === 'none') return;
      const component = document.createElement('em');
      component.textContent = d.component == null ? '' : ` · ${d.component}`;
      const file = document.createElement('i');
      file.textContent = d.source == null ? '' : ` ${d.source.file}:${String(d.source.line)}`;
      if (ui.tag.firstChild === title) ui.tag.append(component, file);
    });
  }

  // --- events, all in the capture phase so the page never sees a click made in pick mode ---
  let hovered: Element | null = null;
  window.addEventListener(
    'pointermove',
    (event) => {
      if (drag !== null) {
        if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > DRAG_START_PX)
          drag.moved = true;
        if (drag.moved) {
          ui.hover.style.display = 'none';
          ui.marquee.style.display = 'block';
          place(ui.marquee, {
            x: Math.min(drag.x, event.clientX),
            y: Math.min(drag.y, event.clientY),
            width: Math.abs(event.clientX - drag.x),
            height: Math.abs(event.clientY - drag.y),
          });
        }
        return;
      }
      if (!picking || passthrough || open !== null) return;
      const element = at(event.clientX, event.clientY);
      if (element === hovered) return;
      hovered = element;
      if (element === null) ui.hover.style.display = 'none';
      else showHover(element);
    },
    true,
  );
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!picking || passthrough || ours(event.target) || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        shift: event.shiftKey,
        target: at(event.clientX, event.clientY),
      };
    },
    true,
  );
  window.addEventListener(
    'pointerup',
    (event) => {
      const started = drag;
      if (started === null) return;
      drag = null;
      ui.marquee.style.display = 'none';
      event.preventDefault();
      event.stopPropagation();
      if (open !== null && !started.shift) closeNote();
      if (started.moved) pickArea(started.x, started.y, event.clientX, event.clientY);
      else if (started.target !== null) pickElement(started.target, started.shift);
    },
    true,
  );
  for (const type of ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu'] as const) {
    window.addEventListener(
      type,
      (event) => {
        if (picking && !passthrough && !ours(event.target)) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        event.stopPropagation();
        setPicking(!picking);
        return;
      }
      if (event.key === 'Escape' && open !== null) {
        event.preventDefault();
        event.stopPropagation();
        closeNote();
        return;
      }
      if (event.key === 'Escape' && picking) {
        event.preventDefault();
        setPicking(false);
        return;
      }
      if (event.key === 'Alt' && picking) {
        passthrough = true;
        ui.hover.style.display = 'none';
      }
      if (event.key === 'Shift' && open !== null) ui.note.classList.add('faded');
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Alt') passthrough = false;
      if (event.key === 'Shift') ui.note.classList.remove('faded');
    },
    true,
  );
  ui.noteText.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      closeNote();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNote();
    }
  });
  ui.noteRemove.addEventListener('click', () => {
    if (open !== null) remove(open);
  });
  ui.pillMark.addEventListener('click', () => {
    setPicking(!picking);
  });
  ui.pillSend.addEventListener('click', () => {
    closeNote();
    void channel.showComposer().catch((error: unknown) => {
      say(refusalOf(error));
    });
  });
  let frame = 0;
  const redraw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  };
  window.addEventListener('scroll', redraw, true);
  window.addEventListener('resize', redraw);

  // The shell's calls (Pick on Page spec §5): drop picks the draft sent, removed or refused, and flash one.
  Object.defineProperty(window, '__tendbPicker', {
    value: Object.freeze({
      drop(ids: unknown, notice: unknown) {
        const dropped = new Set(
          Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [],
        );
        for (const pick of [...picks]) {
          if (!dropped.has(pick.id)) continue;
          const index = picks.indexOf(pick);
          if (index >= 0) picks.splice(index, 1);
          if (open === pick) {
            open = null;
            ui.note.style.display = 'none';
          }
        }
        if (typeof notice === 'string' && notice !== '') say(notice);
        render();
      },
      flash(id: unknown) {
        const badge = [...ui.marks.querySelectorAll<HTMLElement>('.badge')].find(
          (b) => b.dataset['pick'] === id,
        );
        const pick = picks.find((p) => p.id === id);
        pick?.elements[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (badge === undefined) return;
        badge.classList.remove('flash');
        // Reading the box makes the browser restart the animation.
        badge.getBoundingClientRect();
        badge.classList.add('flash');
      },
    }),
  });
  render();
}
