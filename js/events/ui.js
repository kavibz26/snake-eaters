// Match-event presentation: paced toasts during play and the "Match events" list on result screens.
// DOM only; the events themselves always come from the simulation / the server. All text is written with
// textContent (player names are untrusted).
import { MATCH_EVENTS, EVENT_TOAST } from './config.js';

const $ = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// { icon, title, detail, major, toast } for an event, or null for an unknown id.
export function describeEvent(ev, nameOf) {
  const def = ev && MATCH_EVENTS[ev.k];
  if (!def) return null;
  const who = nameOf(ev.id);
  const n = ev.n;
  const details = {
    first_blood: `${who} eliminated ${nameOf(ev.v)}`,
    food_hunter: `${who}: ${n ?? def.food} food eaten`,
    power_collector: `${who}: ${n ?? def.powerups} power-ups`,
    giant_snake: `${who}: length ${n ?? def.length}`,
    survivor: `${who}: ${n ?? def.seconds}s alive`,
    longest_snake: `${who}: length ${n ?? '?'}`,
    most_food: `${who}: ${n ?? '?'} food`,
    comeback: `${who}: climbed to first place`,
  };
  return { icon: def.icon, title: def.name, detail: details[ev.k] || who, major: def.prominence === 'major', toast: def.toast === true, who };
}

// One toast at a time, short-lived, small queue: a burst of events never becomes a wall of banners.
// `canvas` (optional): the toast is kept narrower than the arena it floats over (on landscape phones the arena is
// narrower than the space it sits in).
export function createEventToaster(root, canvas = null) {
  const queue = [];
  let showing = false;
  let timer = null;

  function hide() {
    showing = false;
    root.classList.add('hidden');
    root.textContent = '';
    next();
  }

  function next() {
    if (showing || !queue.length) return;
    const d = queue.shift();
    showing = true;
    root.textContent = '';
    root.className = `event-toast${d.major ? ' event-toast--major' : ''}${d.mine ? ' event-toast--mine' : ''}`;
    const text = $('span', 'event-toast-text');
    text.append($('strong', 'event-toast-title', d.title), $('span', 'event-toast-detail', d.detail));
    root.append($('span', 'event-toast-icon', d.icon), text);
    if (canvas && canvas.clientWidth) root.style.maxWidth = `${Math.floor(canvas.clientWidth * 0.96)}px`;
    void root.offsetWidth; // restart the entrance animation
    clearTimeout(timer);
    timer = setTimeout(hide, d.major ? EVENT_TOAST.majorMs : EVENT_TOAST.minorMs);
  }

  return {
    // opts.mine: this event is the local player's. Returns true if it was queued.
    show(ev, nameOf, opts = {}) {
      const d = describeEvent(ev, nameOf);
      if (!d || !d.toast) return false; // final events ("Most Food"...) are only listed in the results
      queue.push({ ...d, mine: Boolean(opts.mine) });
      while (queue.length > EVENT_TOAST.maxQueue) {
        const drop = queue.findIndex((q) => !q.major); // shed a routine one first
        queue.splice(drop >= 0 ? drop : 0, 1);
      }
      next();
      return true;
    },
    clear() {
      queue.length = 0;
      clearTimeout(timer);
      showing = false;
      root.classList.add('hidden');
      root.textContent = '';
    },
  };
}

// events: [{ k, id, v?, n? }]. opts: { nameOf, myId } - the local player's events are highlighted.
export function renderEventSummary(container, events, { nameOf, myId }) {
  container.textContent = '';
  const list = (events || []).map((e) => ({ e, d: describeEvent(e, nameOf) })).filter((x) => x.d);
  if (!list.length) {
    container.classList.add('hidden');
    return 0;
  }
  container.classList.remove('hidden');
  container.appendChild($('div', 'event-summary-title', 'Match events'));
  const ul = $('ul', 'event-chips');
  for (const { e, d } of list) {
    const li = $('li', `event-chip${e.id === myId ? ' event-chip--mine' : ''}${d.major ? ' event-chip--major' : ''}`);
    li.append($('span', 'event-chip-icon', d.icon), $('span', 'event-chip-name', d.title), $('span', 'event-chip-who', d.who));
    ul.appendChild(li);
  }
  container.appendChild(ul);
  return list.length;
}
