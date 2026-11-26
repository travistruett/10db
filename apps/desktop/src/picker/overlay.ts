// Pick on Page spec §3: what the picker draws over the page, in a closed shadow root at the top of the
// document, so the page's styles never reach it. The colors are 10db's (Selenized dark), fixed here
// because the page carries none of 10db's theme.

import type { PickRect } from '@10db/contracts';

const STYLE = `
:host { all: initial; font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
.hover { position: fixed; border: 2px solid #4695f7; background: rgba(70,149,247,.10); border-radius: 3px; display: none; }
.tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; background: #103c48; color: #cad8d9;
  font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 7px; border-radius: 4px;
  white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3); max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
.tag.below { bottom: auto; top: 100%; margin: 4px 0 0; }
.tag em { color: #41c7b9; font-style: normal; } .tag i { color: #72898f; font-style: normal; }
.box { position: fixed; border: 2px solid #f275be; border-radius: 3px; background: rgba(242,117,190,.08); }
.box.group { border-style: dashed; }
.box.active { background: rgba(242,117,190,.18); box-shadow: 0 0 0 1px #f275be; }
.box.dim, .badge.dim { opacity: .3; }
.badge { position: fixed; transform: translate(-50%,-50%); min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: #f275be; color: #103c48; font: 600 11px/20px -apple-system, system-ui, sans-serif; text-align: center;
  box-shadow: 0 1px 4px rgba(0,0,0,.35); pointer-events: auto; cursor: pointer; }
.badge.flash { animation: flash .9s ease 2; }
@keyframes flash { 50% { transform: translate(-50%,-50%) scale(1.5); } }
.marquee { position: fixed; border: 1.5px dashed #f275be; background: rgba(242,117,190,.07); display: none; }
.note { position: fixed; width: 360px; background: #103c48; color: #adbcbc; border: 1px solid #2d5b69; border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.4); padding: 12px 14px 12px; pointer-events: auto; display: none; }
.head { display: flex; gap: 7px; align-items: center; cursor: grab; user-select: none; font-size: 12px; margin: 0 -4px 4px 0; min-width: 0; }
.n { background: #f275be; color: #103c48; border-radius: 9px; padding: 0 6px; font-weight: 600; flex: none; }
.scope { color: #cad8d9; font-weight: 600; }
.src { display: block; font: 11px ui-monospace, Menlo, monospace; color: #41c7b9; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; margin: 0 0 10px; min-height: 1.4em; }
textarea { width: 100%; min-height: 88px; resize: none; background: #184956; color: #cad8d9; border: 1px solid #2d5b69;
  border-radius: 7px; padding: 7px 8px; font: 13px/1.4 -apple-system, system-ui, sans-serif; outline: none; }
textarea:focus { border-color: #4695f7; }
.foot { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: #72898f; }
.quiet { background: none; border: 0; color: #72898f; font-size: 11.5px; padding: 3px 4px; }
.quiet:hover { color: #cad8d9; }
.danger { color: #c1747a; }
.danger:hover { color: #fa5750; }
.close { margin-left: auto; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; background: none;
  border: 0; border-radius: 5px; color: #72898f; flex: none; }
.close:hover { background: #184956; color: #cad8d9; }
.save { background: #f275be; color: #103c48; border: 0; border-radius: 6px; padding: 4px 12px; font-size: 12px; font-weight: 600; }
.save:hover { background: #f58bca; }
.grow { flex: 1; }
button { font: inherit; cursor: pointer; }
.ghost { background: #184956; color: #adbcbc; border: 1px solid #2d5b69; border-radius: 6px; padding: 3px 7px; font-size: 11.5px; }
.ghost:hover { background: #2d5b69; }
.mic { width: 26px; height: 24px; display: grid; place-items: center; padding: 0; }
kbd { font: 10.5px ui-monospace, Menlo, monospace; background: #184956; border: 1px solid #2d5b69; border-bottom-width: 2px;
  border-radius: 4px; padding: 0 4px; color: #adbcbc; }
.pill { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; position: fixed; left: 16px; bottom: 16px; display: flex; align-items: center; height: 36px; border-radius: 18px;
  background: #103c48; color: #cad8d9; box-shadow: 0 6px 20px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06) inset;
  font-size: 12.5px; user-select: none; pointer-events: auto; z-index: 2147483647; }
.pill.picking { box-shadow: 0 6px 20px rgba(0,0,0,.35), 0 0 0 2px #f275be; }
.pill:not(.picking) { background: #f275be; color: #103c48; font-weight: 600;
  box-shadow: 0 6px 18px rgba(242,117,190,.4), 0 1px 4px rgba(0,0,0,.25); }
.pill:not(.picking):hover { background: #f58bca; }
.pill:not(.picking) .send { background: #103c48; color: #f58bca; }
.mark { width: 36px; height: 36px; display: grid; place-items: center; background: none; border: 0; color: inherit; padding: 0; }
.picking .mark { color: #f275be; }
.start { display: inline-flex; align-items: center; gap: 8px; padding: 0 12px 0 0; height: 36px; background: none;
  border: 0; color: inherit; white-space: nowrap; }
.picking .start { display: none; }
.mode { display: none; align-items: center; gap: 8px; padding: 0 12px 0 2px; white-space: nowrap; }
.picking .mode { display: inline-flex; }
.sep { width: 1px; height: 18px; background: #2d5b69; }
.count { color: #72898f; }
.dragging, .dragging .head { cursor: grabbing; }
.send { display: none; align-items: center; gap: 2px; background: #f275be; color: #103c48; border: 0; height: 22px; border-radius: 11px; padding: 0 9px;
  font-weight: 600; font-size: 11.5px; margin: 0 2px 0 4px; }
.has .send { display: inline-flex; }
.send svg { display: block; }
.has .sep, .has .count { display: none; }
.clear { display: none; background: none; border: 0; color: #72898f; height: 26px; padding: 0 6px; font-size: 12px; }
.clear:hover { color: #cad8d9; }
.has .clear { display: inline-block; }
.pill:not(.picking) .clear { color: #103c48; margin-right: 8px; }
.exit { display: none; width: 26px; height: 26px; border-radius: 13px; margin-right: 5px; background: none; border: 0;
  color: #72898f; place-items: center; padding: 0; }
.exit:hover { background: #184956; color: #cad8d9; }
.picking .exit { display: grid; }
.notice { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; position: fixed; left: 16px; bottom: 60px; background: #103c48; color: #fa5750; padding: 6px 10px; border-radius: 7px;
  font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.3); display: none; pointer-events: none; z-index: 2147483647; }
`;

const MIC = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/></svg>`;
const CLOSE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

const MARK = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4l6.5 16 2.3-6.7L19.5 11z"/><path d="M13 13l6 6"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Node,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

export interface Overlay {
  readonly host: HTMLElement;
  readonly hover: HTMLElement;
  readonly tag: HTMLElement;
  readonly marquee: HTMLElement;
  readonly marks: HTMLElement;
  readonly note: HTMLElement;
  readonly noteNumber: HTMLElement;
  readonly noteScope: HTMLElement;
  readonly noteSource: HTMLElement;
  readonly noteText: HTMLTextAreaElement;
  readonly noteDictate: HTMLButtonElement;
  readonly noteRemove: HTMLButtonElement;
  readonly noteCancel: HTMLButtonElement;
  readonly noteSave: HTMLButtonElement;
  readonly pill: HTMLElement;
  readonly pillMark: HTMLButtonElement;
  readonly pillStart: HTMLButtonElement;
  readonly pillExit: HTMLButtonElement;
  readonly pillCount: HTMLElement;
  readonly pillSend: HTMLButtonElement;
  readonly pillClear: HTMLButtonElement;
  readonly notice: HTMLElement;
}

/** Draws the picker's layer into a closed shadow root on the document's root element. */
export function createOverlay(): Overlay {
  const host = document.createElement('tendb-picker');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);
  const layer = el('div', 'layer', root);
  const hover = el('div', 'hover', layer);
  const tag = el('div', 'tag', hover);
  const marquee = el('div', 'marquee', layer);
  const marks = el('div', '', layer);
  const note = el('div', 'note', layer);
  const head = el('div', 'head', note);
  const noteNumber = el('span', 'n', head);
  const noteScope = el('span', 'scope', head);
  const noteCancel = el('button', 'close', head);
  noteCancel.innerHTML = CLOSE;
  noteCancel.title = 'Close without saving (esc)';
  noteCancel.setAttribute('aria-label', 'Close without saving');
  const noteSource = el('code', 'src', note);
  const noteText = el('textarea', '', note);
  noteText.placeholder = 'What should change?';
  noteText.setAttribute('aria-label', 'Note for this pick');
  const foot = el('div', 'foot', note);
  const noteRemove = el('button', 'quiet danger', foot);
  noteRemove.textContent = 'Remove';
  el('span', 'grow', foot);
  const noteDictate = el('button', 'ghost mic', foot);
  noteDictate.innerHTML = MIC;
  noteDictate.title = 'Dictate';
  noteDictate.setAttribute('aria-label', 'Dictate');
  const noteSave = el('button', 'save', foot);
  noteSave.textContent = 'Save';
  noteSave.title = 'Save (↩)';
  const pill = el('div', 'pill', root);
  const pillMark = el('button', 'mark', pill);
  pillMark.innerHTML = MARK;
  pillMark.title = 'Mark up this page (⌘⇧C)';
  pillMark.setAttribute('aria-label', 'Mark up this page');
  const pillStart = el('button', 'start', pill);
  pillStart.textContent = 'Mark up';
  pillStart.title = 'Mark up this page (⌘⇧C)';
  const mode = el('span', 'mode', pill);
  mode.append('Picking');
  el('span', 'sep', mode);
  const pillCount = el('span', 'count', mode);
  const pillSend = el('button', 'send', pill);
  const pillClear = el('button', 'clear', pill);
  pillClear.textContent = 'Clear';
  pillClear.title = 'Remove every pick';
  const pillExit = el('button', 'exit', pill);
  pillExit.innerHTML = CLOSE;
  pillExit.title = 'Stop picking; an open note is saved';
  pillExit.setAttribute('aria-label', 'Stop picking');
  const notice = el('div', 'notice', root);
  document.documentElement.appendChild(host);
  return {
    host,
    hover,
    tag,
    marquee,
    marks,
    note,
    noteNumber,
    noteScope,
    noteSource,
    noteText,
    noteDictate,
    noteRemove,
    noteCancel,
    noteSave,
    pill,
    pillMark,
    pillStart,
    pillExit,
    pillCount,
    pillSend,
    pillClear,
    notice,
  };
}

/** Places a fixed element on a viewport box. */
export function place(node: HTMLElement, r: PickRect): void {
  node.style.left = `${String(r.x)}px`;
  node.style.top = `${String(r.y)}px`;
  node.style.width = `${String(r.width)}px`;
  node.style.height = `${String(r.height)}px`;
}
