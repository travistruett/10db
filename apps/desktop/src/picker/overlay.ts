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
.badge { position: fixed; transform: translate(-50%,-50%); min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: #f275be; color: #103c48; font: 600 11px/20px -apple-system, system-ui, sans-serif; text-align: center;
  box-shadow: 0 1px 4px rgba(0,0,0,.35); pointer-events: auto; cursor: pointer; }
.badge.flash { animation: flash .9s ease 2; }
@keyframes flash { 50% { transform: translate(-50%,-50%) scale(1.5); } }
.marquee { position: fixed; border: 1.5px dashed #f275be; background: rgba(242,117,190,.07); display: none; }
.note { position: fixed; width: 300px; background: #103c48; color: #adbcbc; border: 1px solid #2d5b69; border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.4); padding: 10px; pointer-events: auto; display: none; }
.note.faded { opacity: .2; pointer-events: none; }
.head { display: flex; gap: 6px; align-items: center; font-size: 11.5px; margin-bottom: 6px; min-width: 0; }
.n { background: #f275be; color: #103c48; border-radius: 9px; padding: 0 6px; font-weight: 600; flex: none; }
.head code { font: 11px ui-monospace, Menlo, monospace; color: #41c7b9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
textarea { width: 100%; min-height: 54px; resize: none; background: #184956; color: #cad8d9; border: 1px solid #2d5b69;
  border-radius: 7px; padding: 7px 8px; font: 13px/1.4 -apple-system, system-ui, sans-serif; outline: none; }
textarea:focus { border-color: #4695f7; }
.foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: #72898f; }
.grow { flex: 1; }
button { font: inherit; cursor: pointer; }
.ghost { background: #184956; color: #adbcbc; border: 1px solid #2d5b69; border-radius: 6px; padding: 3px 7px; font-size: 11.5px; }
.ghost:hover { background: #2d5b69; }
kbd { font: 10.5px ui-monospace, Menlo, monospace; background: #184956; border: 1px solid #2d5b69; border-bottom-width: 2px;
  border-radius: 4px; padding: 0 4px; color: #adbcbc; }
.pill { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; position: fixed; left: 16px; bottom: 16px; display: flex; align-items: center; height: 36px; border-radius: 18px;
  background: #103c48; color: #cad8d9; box-shadow: 0 6px 20px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06) inset;
  font-size: 12.5px; user-select: none; pointer-events: auto; z-index: 2147483647; }
.pill.picking { box-shadow: 0 6px 20px rgba(0,0,0,.35), 0 0 0 2px #f275be; }
.mark { width: 36px; height: 36px; display: grid; place-items: center; background: none; border: 0; color: inherit; padding: 0; }
.picking .mark { color: #f275be; }
.mode { display: none; align-items: center; gap: 8px; padding: 0 12px 0 2px; white-space: nowrap; }
.picking .mode { display: inline-flex; }
.sep { width: 1px; height: 18px; background: #2d5b69; }
.count { color: #72898f; }
.send { display: none; background: #f275be; color: #103c48; border: 0; height: 26px; border-radius: 13px; padding: 0 11px;
  font-weight: 600; font-size: 12px; margin-right: 5px; }
.has .send { display: inline-block; }
.notice { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; position: fixed; left: 16px; bottom: 60px; background: #103c48; color: #fa5750; padding: 6px 10px; border-radius: 7px;
  font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.3); display: none; pointer-events: none; z-index: 2147483647; }
`;

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
  readonly noteSource: HTMLElement;
  readonly noteText: HTMLTextAreaElement;
  readonly noteRemove: HTMLButtonElement;
  readonly pill: HTMLElement;
  readonly pillMark: HTMLButtonElement;
  readonly pillCount: HTMLElement;
  readonly pillSend: HTMLButtonElement;
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
  const noteSource = el('code', '', head);
  const noteText = el('textarea', '', note);
  noteText.placeholder = 'What should change? (fn fn to dictate)';
  noteText.setAttribute('aria-label', 'Note for this pick');
  const foot = el('div', 'foot', note);
  foot.innerHTML =
    '<span><kbd>↩</kbd> save</span><span><kbd>⇧↩</kbd> line</span><span><kbd>esc</kbd> no note</span><span class="grow"></span>';
  const noteRemove = el('button', 'ghost', foot);
  noteRemove.textContent = 'Remove';
  const pill = el('div', 'pill', root);
  const pillMark = el('button', 'mark', pill);
  pillMark.innerHTML = MARK;
  pillMark.title = 'Pick on Page (⌘⇧C)';
  pillMark.setAttribute('aria-label', 'Pick on Page');
  const mode = el('span', 'mode', pill);
  mode.append('Picking');
  el('span', 'sep', mode);
  const pillCount = el('span', 'count', mode);
  const pillSend = el('button', 'send', pill);
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
    noteSource,
    noteText,
    noteRemove,
    pill,
    pillMark,
    pillCount,
    pillSend,
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
