// Pick on Page spec §3: pick mode in the page. The pill (or ⌘⇧C) toggles it; hover outlines, a click
// picks one element and opens its note, ⇧-click adds an element to the newest pick, a drag picks an area,
// ⌥ held hands the page back. A saved note sends the pick to the shell, which crops it and hands it to
// the page's draft in 10db; nothing here sends a message.

import type { PickKind as Kind, PickRect } from '@10db/contracts';
import { getElementAtPoint, isElementGrabbable } from 'react-grab/primitives';
import { channel, refusalOf } from './channel';
import { createOverlay, place, type Overlay } from './overlay';
import {
  boxOf,
  describe,
  describeNow,
  elementTitle,
  type PagePickInput,
  type PickElementInput,
} from './pick';

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
  /** Not yet saved once: Cancel takes it back out rather than just closing its note. */
  fresh: boolean;
  /** The shell took it once: its chip exists, so a refused edit keeps the badge. */
  added: boolean;
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

const CHEVRON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;

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
  /** Crops the shell is taking: the picker's layer stays hidden until the last one is done. */
  let shooting = 0;

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
    ui.pillCount.textContent = 'click an element';
    ui.pillSend.replaceChildren('Back to 10db');
    ui.pillSend.insertAdjacentHTML('beforeend', CHEVRON);
    ui.pillSend.title = `${String(picks.length)} pick${picks.length === 1 ? '' : 's'} on ${page ?? 'this page'} in 10db`;
    ui.marks.replaceChildren();
    picks.forEach((pick, index) => {
      boxesOf(pick).forEach((r, i) => {
        const box = document.createElement('div');
        // While a note is open, its pick stands out and the others step back.
        const focus = open === null ? '' : open === pick ? ' active' : ' dim';
        box.className = `${pick.kind === PickKind.Element ? 'box' : 'box group'}${focus}`;
        place(box, r);
        ui.marks.appendChild(box);
        if (i > 0) return;
        const badge = document.createElement('div');
        badge.className = open === null || open === pick ? 'badge' : 'badge dim';
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
      ? `${name}${where} and ${String(pick.elements.length - 1)} more`
      : `${name}${where}`;
  }

  /** Says whom the note is for: this one pick, or every element ⇧-clicked into it. */
  function scopeLine(pick: Pick): string {
    if (pick.area !== null) return 'One note for this area';
    if (pick.elements.length > 1)
      return `One note for these ${String(pick.elements.length)} elements`;
    return 'Note for this element only';
  }

  function openNote(pick: Pick) {
    // Already open on this pick (a ⇧-click grew or shrank it): its header changes, and what is typed
    // and where it was dragged stay.
    // Another pick's open note is saved first, so what was typed there is never dropped.
    if (open !== null && open !== pick) closeNote();
    const already = open === pick && ui.note.style.display === 'block';
    open = pick;
    ui.noteNumber.textContent = String(picks.indexOf(pick) + 1);
    ui.noteScope.textContent = scopeLine(pick);
    ui.noteSource.textContent = sourceLine(pick, null);
    const first = pick.elements[0];
    const lookup = first === undefined ? undefined : pick.described.get(first);
    void lookup?.then((d) => {
      if (open === pick) ui.noteSource.textContent = sourceLine(pick, d);
    });
    if (already) {
      ui.noteText.focus();
      render();
      return;
    }
    ui.noteText.value = pick.note;
    ui.noteRemove.style.display = pick.fresh ? 'none' : '';
    ui.note.style.display = 'block';
    // Placed beside the pick, or below or above it, and kept inside the window, measured once drawn.
    const width = ui.note.offsetWidth;
    const height = ui.note.offsetHeight;
    const boxes = boxesOf(pick);
    const anchor = boxes[boxes.length - 1] ?? { x: 16, y: 16, width: 0, height: 0 };
    let left = anchor.x + anchor.width + 12;
    let top = anchor.y - 6;
    if (left + width + 8 > window.innerWidth) {
      left = anchor.x;
      top = anchor.y + anchor.height + 8;
      if (top + height + 8 > window.innerHeight) top = anchor.y - height - 8;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    ui.note.style.left = `${String(left)}px`;
    ui.note.style.top = `${String(top)}px`;
    ui.noteText.focus();
    ui.hover.style.display = 'none';
    render();
  }

  function closeNote() {
    const pick = open;
    if (pick === null) return;
    pick.note = ui.noteText.value.trim();
    pick.fresh = false;
    open = null;
    ui.note.style.display = 'none';
    render();
    void send(pick);
  }

  async function send(pick: Pick) {
    const elements = await Promise.all(
      pick.elements.map((element) =>
        Promise.race([
          pick.described.get(element) ?? describe(element, config.repoPath),
          sleep(LOOKUP_WAIT_MS),
        ]).then((described) => described ?? describeNow(element)),
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
    // Removed while its lookup ran: nothing goes.
    if (!picks.includes(pick)) return;
    // The crop is WebKit's picture of the page as painted, so the picker's whole layer (badges, boxes,
    // any note open by now) is hidden from the frame before it until the shell answers.
    shooting += 1;
    ui.host.style.visibility = 'hidden';
    try {
      await nextFrame();
      page = (await channel.add(input)) ?? page;
      pick.added = true;
      // Removed while the shell took it: its chip goes too.
      if (!picks.includes(pick)) void channel.remove(pick.id).catch(() => undefined);
    } catch (error) {
      // A refused pick leaves no badge without a chip; a refused edit keeps both, as they were.
      const index = picks.indexOf(pick);
      if (!pick.added && index >= 0) picks.splice(index, 1);
      say(refusalOf(error));
    } finally {
      shooting -= 1;
      if (shooting === 0) ui.host.style.visibility = '';
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

  /** Cancel: a pick just made goes back out; a reopened one keeps its note as it was. */
  function cancelNote() {
    const pick = open;
    if (pick === null) return;
    if (pick.fresh) {
      remove(pick);
      return;
    }
    open = null;
    ui.note.style.display = 'none';
    render();
  }

  /** Removing the pick whose note was open moves the note to the newest pick left, so it never just vanishes. */
  function removeAndReopen(pick: Pick, wasOpen: boolean) {
    remove(pick);
    const next = picks[picks.length - 1];
    if (wasOpen && next !== undefined) openNote(next);
  }

  /** A saved note, or words typed into its open note: either is never dropped by a click. */
  function hasNote(pick: Pick): boolean {
    return pick.note !== '' || (open === pick && ui.noteText.value.trim() !== '');
  }

  function track(pick: Pick, element: Element) {
    pick.elements.push(element);
    pick.described.set(element, describe(element, config.repoPath));
  }

  function untrack(pick: Pick, element: Element) {
    const index = pick.elements.indexOf(element);
    if (index >= 0) pick.elements.splice(index, 1);
    pick.described.delete(element);
    if (pick.elements.length === 1) pick.kind = PickKind.Element;
  }

  /** A click toggles: ⇧ takes a member out of the group, and a plain click unpicks an element with no note. */
  function pickElement(element: Element, shift: boolean, wasOpen: Pick | null) {
    const newest = picks[picks.length - 1];
    if (shift && newest !== undefined) {
      if (newest.area === null && newest.elements.includes(element)) {
        if (newest.elements.length === 1 && !hasNote(newest)) {
          removeAndReopen(newest, wasOpen === newest);
          return;
        }
        if (newest.elements.length > 1) untrack(newest, element);
      } else if (
        !newest.elements.includes(element) &&
        newest.elements.length < PAGE_PICK_ELEMENTS_MAX
      ) {
        track(newest, element);
        newest.kind = PickKind.Group;
        newest.area = null;
      }
      // A saved pick's chip follows its outlines at once, so closing its note without saving keeps them
      // the same in the page and in 10db.
      if (!newest.fresh) void send(newest);
      openNote(newest);
      render();
      return;
    }
    const holder = picks.find((p) => p.area === null && p.elements.includes(element));
    if (holder !== undefined) {
      // A note is never lost to a stray click: the pick opens instead.
      if (holder.note === '' && holder.elements.length === 1)
        removeAndReopen(holder, wasOpen === holder);
      else openNote(holder);
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
      added: false,
      fresh: true,
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
      added: false,
      fresh: true,
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
      const wasOpen = open;
      if (open !== null && !started.shift) closeNote();
      if (started.moved) pickArea(started.x, started.y, event.clientX, event.clientY);
      else if (started.target !== null) pickElement(started.target, started.shift, wasOpen);
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
        cancelNote();
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
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Alt') passthrough = false;
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
      cancelNote();
    }
  });
  if (!channel.available()) ui.noteDictate.style.display = 'none';
  // The button must not take focus: dictation goes to the field that has it.
  ui.noteDictate.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });
  ui.noteDictate.addEventListener('click', () => {
    ui.noteText.focus();
    void channel.dictate().catch((error: unknown) => {
      say(refusalOf(error));
    });
  });
  ui.noteRemove.addEventListener('click', () => {
    if (open !== null) removeAndReopen(open, true);
  });
  ui.noteCancel.addEventListener('click', cancelNote);
  // The note moves by its header, so whatever it covers can still be picked.
  const head = ui.noteScope.parentElement;
  head?.addEventListener('pointerdown', (event) => {
    // Anywhere on the header but its close button.
    const onButton = event.target instanceof Element && event.target.closest('button') !== null;
    if (event.button !== 0 || onButton) return;
    event.preventDefault();
    const box = ui.note.getBoundingClientRect();
    const dx = event.clientX - box.left;
    const dy = event.clientY - box.top;
    head.setPointerCapture(event.pointerId);
    ui.note.classList.add('dragging');
    const move = (e: PointerEvent) => {
      const left = Math.min(Math.max(8, e.clientX - dx), window.innerWidth - box.width - 8);
      const top = Math.min(Math.max(8, e.clientY - dy), window.innerHeight - box.height - 8);
      ui.note.style.left = `${String(left)}px`;
      ui.note.style.top = `${String(top)}px`;
    };
    const end = () => {
      ui.note.classList.remove('dragging');
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', end);
      head.removeEventListener('pointercancel', end);
      head.removeEventListener('lostpointercapture', end);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
    head.addEventListener('lostpointercapture', end);
  });
  ui.noteSave.addEventListener('click', closeNote);
  ui.pillClear.addEventListener('click', () => {
    for (const pick of [...picks]) remove(pick);
  });
  ui.pillMark.addEventListener('click', () => {
    setPicking(!picking);
  });
  ui.pillStart.addEventListener('click', () => {
    setPicking(true);
  });
  ui.pillExit.addEventListener('click', () => {
    setPicking(false);
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
  // ⌥ let go in another window never reaches this one.
  window.addEventListener('blur', () => {
    passthrough = false;
  });

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
