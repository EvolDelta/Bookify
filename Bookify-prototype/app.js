/* Gather — event reservation prototype.
 * Plain JavaScript: one state object, a render() that rebuilds the page from
 * template strings, and a small DOM patcher so focus, scroll and hover states
 * survive re-renders. No framework, no build step. */
'use strict';

// Tunables (were design-tool props in the original bundle).
const CONFIG = {
  holdMinutes: 5,        // how long seats stay held while paying
  serviceFee: 1.75,      // € per seat, never discounted
  promoAutoRotate: true  // rotate the featured-offer carousel every 6s
};

const L = 'ABCDEFGHJKLMNP';
const euro = n => '€' + n.toFixed(2);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ───────────────────────── rendering helpers ───────────────────────── */

// html`...` escapes every interpolated value unless it is itself html`...`.
// Arrays are joined, null/undefined/true/false render nothing, and a function
// is registered as an event handler and replaced by its id (used as
// data-click="${fn}" / data-input="${fn}").
class Raw { constructor(s) { this.s = s; } }
let handlers = [];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  if (v === null || v === undefined || v === false || v === true) return '';
  if (typeof v === 'function') return String(handlers.push(v) - 1);
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += fmt(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// Patch `from` in place to match `to`. Children with a data-key are matched by
// key (so a banner appearing above them doesn't force a rebuild); the rest are
// matched by position when the tag agrees.
function sameNode(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  return a.nodeType !== 1 || a.getAttribute('data-key') === b.getAttribute('data-key');
}
function morphChildren(from, to) {
  const keyed = new Map();
  for (const n of from.childNodes) if (n.nodeType === 1 && n.hasAttribute('data-key')) keyed.set(n.getAttribute('data-key'), n);
  const b = Array.from(to.childNodes);
  b.forEach((y, i) => {
    const cur = from.childNodes[i] || null;
    const key = y.nodeType === 1 ? y.getAttribute('data-key') : null;
    let x = key !== null ? keyed.get(key) : cur;
    if (key !== null) keyed.delete(key);
    if (x && !sameNode(x, y)) x = null;
    if (!x) { from.insertBefore(y, cur); return; }
    if (x !== cur) from.insertBefore(x, cur);
    if (x.nodeType === 1) morphEl(x, y);
    else if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
  });
  while (from.childNodes.length > b.length) from.lastChild.remove();
}
function morphEl(from, to) {
  for (const { name } of Array.from(from.attributes)) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of Array.from(to.attributes)) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  morphChildren(from, to);
  if ((from.tagName === 'INPUT' || from.tagName === 'TEXTAREA') && from.value !== to.value) from.value = to.value;
}

/* ───────────────────────────── state ───────────────────────────── */

const state = {
  role: 'attendee', view: 'browse', oview: 'dash',
  query: '', cat: 'All', promo: 0,
  eventId: 'e1', selected: [], holdStart: 0, holdEvent: null,
  code: '', appliedCode: null, codeMsg: '', codeOk: false,
  f: { name: '', email: '', card: '', exp: '', cvc: '' },
  a: { name: '', email: '' }, user: null,
  touched: false, authTouched: false, paying: false,
  orders: [], expired: [], lastOrder: null, mineTab: 'upcoming',
  n: { title: '', cat: 'Live music', venue: '', date: '', time: '20:30', about: '', price: '38', rows: '8', cols: '16', hold: 5 },
  nTouched: false,
  g: { type: 'percent', value: '25', code: '', cap: '200', event: 'all', featured: true },
  gTouched: false,
  events: [
    { id: 'e1', title: 'Autumn Sessions — Night Four', cat: 'Live music', venue: 'Teatro Sá da Bandeira, Lisbon', date: '2026-10-17', time: '20:30', price: 45, rows: 8, cols: 18, hold: 5, mine: true, about: 'A four-set evening across the main hall and the upper gallery. Doors at 20:00, seated throughout, back by midnight.' },
    { id: 'e2', title: 'Build Week: systems track', cat: 'Conference', venue: 'Fábrica Pavilion, Porto', date: '2026-10-18', time: '10:00', price: 60, rows: 7, cols: 14, hold: 10, mine: true, about: 'Six talks and two clinics on building and maintaining design systems at scale. Lunch included.' },
    { id: 'e3', title: 'Derby night — Norte vs Sul', cat: 'Sports', venue: 'Estádio Municipal, Braga', date: '2026-10-23', time: '19:00', price: 35, rows: 9, cols: 20, hold: 5, mine: false, about: 'League fixture, away end closed. Reserved seating in the east stand only.' },
    { id: 'e4', title: 'Late Set: improv double bill', cat: 'Comedy', venue: 'Cine Alvalade, Lisbon', date: '2026-10-22', time: '21:00', price: 14, rows: 6, cols: 12, hold: 5, mine: true, about: 'Two troupes, one suggestion from the audience, ninety minutes without a net.' },
    { id: 'e5', title: 'Ceramics intensive', cat: 'Workshop', venue: 'Atelier Rua Verde, Lisbon', date: '2026-10-24', time: '11:00', price: 48, rows: 3, cols: 4, hold: 15, mine: false, about: 'Twelve places only. Wheel work, trimming and a glaze primer; everything fired and posted to you.' }
  ],
  offers: [
    { code: 'AUTUMN40', type: 'percent', value: 40, event: 'e1', cap: 200, used: 148, featured: true, active: true },
    { code: 'DERBY10', type: 'fixed', value: 10, event: 'e3', cap: 500, used: 61, featured: true, active: true },
    { code: 'FRIENDS15', type: 'percent', value: 15, event: 'all', cap: 0, used: 103, featured: false, active: true }
  ],
  baseHolds: 1802, baseExpired: 324, baseStarted: 1556, basePaid: 1284,
  startedHolds: 0, expiredHolds: 0, paymentsStarted: 0,
  now: Date.now(), toast: ''
};

let renderQueued = false;
function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  if (!renderQueued) { renderQueued = true; queueMicrotask(render); }
}

/* ─────────────────────────── domain logic ─────────────────────────── */

let toastTimer;
function say(msg) {
  setState({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: '' }), 2600);
}

const holdMs = () => CONFIG.holdMinutes * 60000;
function holdLeft() {
  if (!state.holdStart) return 0;
  return Math.max(0, state.holdStart + holdMs() - state.now);
}
const findEvent = id => state.events.find(e => e.id === (id || state.eventId)) || state.events[0];
function featured() {
  const f = state.offers.filter(o => o.active && o.featured);
  return f.length ? f : state.offers.filter(o => o.active).slice(0, 1);
}

function seatSold(ev, r, c) {
  const k = r * ev.cols + c;
  if ((k * 7) % 11 === 0 || (k * 13) % 23 === 0) return true;
  return state.orders.some(o => o.eventId === ev.id && o.seatKeys.includes(r + '-' + c));
}
function seatHeldByOther(ev, r, c) { const k = r * ev.cols + c; return (k * 17) % 29 === 0; }
function tierOf(ev, r) {
  if (r === 0 || r === 1) return { name: 'Premium — front', mult: 1.6, mark: 'P' };
  if (r >= ev.rows - 2) return { name: 'Gallery', mult: 0.7, mark: 'G' };
  return { name: 'General — stalls', mult: 1, mark: '' };
}
const seatPrice = (ev, r) => Math.round(ev.price * tierOf(ev, r).mult);
function seatLabel(ev, key) { const [r, c] = key.split('-').map(Number); return L[r] + '-' + (c + 1); }

function offerFor(ev, code) {
  const o = state.offers.find(x => x.active && x.code === String(code || '').trim().toUpperCase());
  if (!o) return null;
  if (o.event !== 'all' && o.event !== ev.id) return { err: 'That code is for a different event.' };
  if (o.cap > 0 && o.used >= o.cap) return { err: 'That code has hit its redemption cap.' };
  return { offer: o };
}
const autoOffer = ev => state.offers.find(o => o.active && o.featured && o.event === ev.id) || null;

function money(ev) {
  const seats = state.selected;
  const sub = seats.reduce((t, k) => t + seatPrice(ev, Number(k.split('-')[0])), 0);
  const ap = state.appliedCode ? state.offers.find(o => o.code === state.appliedCode) : null;
  let disc = 0;
  if (ap) disc = ap.type === 'percent' ? sub * ap.value / 100 : Math.min(sub, ap.value * seats.length);
  const fee = seats.length ? CONFIG.serviceFee * seats.length : 0;
  return { sub, disc, fee, total: Math.max(0, sub - disc + fee), offer: ap };
}

function whenLabel(ev) {
  const d = new Date(ev.date + 'T00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' · ' + ev.time;
}
const capacity = ev => ev.rows * ev.cols;
function soldCount(ev) {
  let n = 0;
  for (let r = 0; r < ev.rows; r++) for (let c = 0; c < ev.cols; c++) if (seatSold(ev, r, c)) n++;
  return n;
}

const go = view => setState({ view, toast: '' });
const openEvent = id => setState({ eventId: id, view: 'event', role: 'attendee' });

function pickSeat(ev, r, c) {
  const key = r + '-' + c;
  if (seatSold(ev, r, c)) return say('That seat is already sold.');
  if (seatHeldByOther(ev, r, c)) return say('Someone else is holding that seat right now.');
  const sel = state.selected;
  if (sel.includes(key)) {
    const next = sel.filter(k => k !== key);
    setState({ selected: next, holdStart: next.length ? state.holdStart : 0, appliedCode: next.length ? state.appliedCode : null, codeMsg: '' });
    return;
  }
  if (sel.length >= 6) return say('Six seats is the maximum per order.');
  const first = sel.length === 0;
  const auto = first ? autoOffer(ev) : null;
  setState({
    selected: sel.concat([key]),
    holdEvent: ev.id,
    holdStart: first ? Date.now() : state.holdStart,
    startedHolds: first ? state.startedHolds + 1 : state.startedHolds,
    appliedCode: state.appliedCode || (auto ? auto.code : null),
    codeMsg: '', code: state.code || (auto ? auto.code : '')
  });
  if (first) say('Seats held for ' + CONFIG.holdMinutes + ' minutes — pay to keep them.');
}

function expire() {
  const ev = findEvent(state.holdEvent);
  setState(s => ({
    expired: s.expired.concat([{ id: 'x' + Date.now(), eventId: ev.id, seats: s.selected.map(k => seatLabel(ev, k)).join(', ') || '—' }]),
    selected: [], holdStart: 0, appliedCode: null, expiredHolds: s.expiredHolds + 1,
    view: s.view === 'checkout' || s.view === 'seats' ? 'event' : s.view
  }));
  say('The hold expired — those seats went back on sale.');
}

function validCheckout() {
  const f = state.f, e = {};
  if (!f.name.trim()) e.name = 'We need a name for the ticket.';
  if (!EMAIL_RE.test(f.email.trim())) e.email = 'That email does not look right.';
  if (f.card.replace(/\D/g, '').length < 15) e.card = 'Enter all 16 digits.';
  if (!/^(0[1-9]|1[0-2])\s*\/\s*\d{2}$/.test(f.exp.trim())) e.exp = 'Use MM/YY.';
  if (f.cvc.replace(/\D/g, '').length < 3) e.cvc = '3 digits.';
  return e;
}

function pay() {
  const errs = validCheckout();
  setState({ touched: true, paymentsStarted: state.paymentsStarted + 1 });
  if (Object.keys(errs).length) return say('Check the highlighted fields.');
  const ev = findEvent(state.holdEvent || state.eventId);
  const m = money(ev);
  setState({ paying: true });
  setTimeout(() => {
    const keys = state.selected.slice();
    const order = {
      id: 'GTH-' + String(4000 + Math.floor(Math.random() * 5999)) + '-' + String(10 + Math.floor(Math.random() * 89)),
      eventId: ev.id, seatKeys: keys, seats: keys.map(k => seatLabel(ev, k)).join(', '),
      total: m.total, code: m.offer ? m.offer.code : '—', discount: m.disc,
      buyer: state.f.name.trim(), email: state.f.email.trim(), status: 'Paid'
    };
    setState(s => ({
      orders: s.orders.concat([order]), lastOrder: order, selected: [], holdStart: 0, paying: false, view: 'confirm',
      offers: s.offers.map(o => (m.offer && o.code === m.offer.code ? Object.assign({}, o, { used: o.used + 1 }) : o)),
      appliedCode: null, code: '', touched: false
    }));
  }, 900);
}

function eventErrors(n) {
  const e = {};
  if (!n.title.trim()) e.nTitle = 'Give it a title.';
  if (!n.venue.trim()) e.nVenue = 'Venue is required.';
  if (!n.date) e.nDate = 'Pick a date.';
  if (!(Number(n.price) > 0)) e.nPrice = 'Price must be above zero.';
  return e;
}

function publishEvent() {
  const n = state.n;
  setState({ nTouched: true });
  if (Object.keys(eventErrors(n)).length) return say('Three checks failed — see the form.');
  const id = 'e' + (state.events.length + 1) + Date.now().toString().slice(-3);
  const ev = {
    id, title: n.title.trim(), cat: n.cat, venue: n.venue.trim(), date: n.date, time: n.time || '20:00',
    price: Number(n.price), rows: Math.max(2, Math.min(14, Number(n.rows) || 8)), cols: Math.max(4, Math.min(22, Number(n.cols) || 16)),
    hold: n.hold, mine: true, about: n.about.trim() || 'Details to follow from the organizer.'
  };
  setState(s => ({ events: s.events.concat([ev]), nTouched: false, n: Object.assign({}, s.n, { title: '', venue: '', about: '' }) }));
  say('“' + ev.title + '” is live in browse with ' + capacity(ev) + ' seats.');
}

function offerErrors(g) {
  const e = {};
  const code = g.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,14}$/.test(code)) e.gCode = '4–14 letters or numbers.';
  else if (state.offers.some(o => o.code === code)) e.gCode = 'That code already exists.';
  if (!(Number(g.value) > 0)) e.gValue = 'Value must be above zero.';
  else if (g.type === 'percent' && Number(g.value) > 90) e.gValue = 'Cap percentage offers at 90%.';
  return e;
}

function publishOffer() {
  const g = state.g;
  const code = g.code.trim().toUpperCase();
  setState({ gTouched: true });
  if (Object.keys(offerErrors(g)).length) return say('Fix the offer fields to publish.');
  const offer = { code, type: g.type === 'code' ? 'percent' : g.type, value: Number(g.value), event: g.event, cap: Number(g.cap) || 0, used: 0, featured: g.type !== 'code' && g.featured, active: true };
  setState(s => ({ offers: s.offers.concat([offer]), gTouched: false, oview: 'dash', g: Object.assign({}, s.g, { code: '' }) }));
  say(code + ' is live — redeemable at checkout' + (offer.featured ? ' and featured in the carousel.' : '.'));
}

/* ───────────────────────── style helpers ───────────────────────── */

function chip(active) {
  return 'padding:6px 12px;border-radius:999px;cursor:pointer;font-family:var(--font-heading);font-weight:500;font-size:12px;' +
    (active ? 'border:1px solid var(--color-accent);background:color-mix(in srgb, var(--color-accent) 16%, transparent);color:var(--color-accent-100)'
            : 'border:1px solid var(--color-neutral-800);background:transparent;color:var(--color-neutral-400)');
}
function navBtn(active) {
  return 'padding:6px 11px;border-radius:var(--radius-md);cursor:pointer;font-family:var(--font-heading);font-weight:500;font-size:13px;white-space:nowrap;' +
    (active ? 'border:1px solid var(--color-accent);background:color-mix(in srgb, var(--color-accent) 14%, transparent);color:var(--color-accent-100)'
            : 'border:1px solid transparent;background:transparent;color:var(--color-neutral-400)');
}
function seg(active) {
  return 'padding:5px 11px;border:0;cursor:pointer;font-family:var(--font-heading);font-weight:500;font-size:12px;' +
    (active ? 'background:color-mix(in srgb, var(--color-accent) 20%, transparent);color:var(--color-accent-100)' : 'background:transparent;color:var(--color-neutral-500)');
}
function pill(kind) {
  const map = {
    ok: 'var(--color-accent-800);color:var(--color-accent-100)',
    quiet: 'var(--color-neutral-900);color:var(--color-neutral-400)'
  };
  return 'padding:3px 9px;border-radius:999px;font-size:10.5px;font-family:var(--font-heading);font-weight:500;background:' + (map[kind] || map.quiet);
}
function card(active) {
  return 'text-align:left;cursor:pointer;padding:var(--space-4) var(--space-6);border-radius:var(--radius-md);display:flex;flex-direction:column;gap:3px;' +
    (active ? 'border:1px solid var(--color-accent);background:color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'border:1px solid var(--color-neutral-800);background:var(--color-surface)');
}

/* ─────────────── view model: everything the markup reads ─────────────── */

function viewModel() {
  const S = state, ev = findEvent(S.holdEvent && (S.view === 'seats' || S.view === 'checkout') ? S.holdEvent : S.eventId);
  const left = holdLeft();
  if (S.holdStart && left === 0) setTimeout(() => { if (holdLeft() === 0 && state.holdStart) expire(); }, 0);
  const m = money(ev);
  const errs = S.touched ? validCheckout() : {};
  const nErr = S.nTouched ? eventErrors(S.n) : {};
  const gErr = S.gTouched ? offerErrors(S.g) : {};
  const bd = c => c ? 'var(--color-accent-500)' : 'var(--color-neutral-800)';
  const set = (key, field, transform = v => v) => e => setState({ [key]: Object.assign({}, state[key], { [field]: transform(e.target.value) }) });

  const feat = featured();
  const pi = Math.min(S.promo, Math.max(0, feat.length - 1));
  const po = feat[pi];
  const poEvent = po && po.event !== 'all' ? findEvent(po.event) : null;
  const attendeeEvents = S.events.filter(e => {
    const q = S.query.trim().toLowerCase();
    const okQ = !q || (e.title + ' ' + e.venue + ' ' + e.cat).toLowerCase().includes(q);
    const okC = S.cat === 'All' || e.cat === S.cat;
    return okQ && okC;
  });
  const cats = ['All'].concat(Array.from(new Set(S.events.map(e => e.cat))));
  const mineOrders = S.orders;

  const rows = [];
  for (let r = 0; r < ev.rows; r++) {
    const tier = tierOf(ev, r), seats = [];
    for (let c = 0; c < ev.cols; c++) {
      const key = r + '-' + c, sold = seatSold(ev, r, c), held = !sold && seatHeldByOther(ev, r, c), mineSeat = S.selected.includes(key);
      seats.push({
        onClick: () => pickSeat(ev, r, c),
        title: L[r] + '-' + (c + 1) + ' · ' + tier.name + ' · ' + euro(seatPrice(ev, r)) + (sold ? ' · sold' : held ? ' · on hold' : ''),
        cursor: sold || held ? 'not-allowed' : 'pointer',
        fill: mineSeat ? 'var(--color-accent)' : sold ? 'var(--color-neutral-800)' : held ? 'var(--color-accent-800)' : 'transparent',
        border: mineSeat ? 'var(--color-accent)' : sold ? 'var(--color-neutral-800)' : held ? 'var(--color-accent-700)' : 'var(--color-neutral-600)'
      });
    }
    rows.push({ label: L[r], tierMark: tier.mark, seats });
  }

  const holdsStarted = S.baseHolds + S.startedHolds, expiredTotal = S.baseExpired + S.expiredHolds;
  const started = S.baseStarted + S.paymentsStarted, paid = S.basePaid + S.orders.length;
  const barSeed = [40, 62, 55, 78, 96, 120, 88, 70, 104, 132, 118, 94, 140, 126];
  const mySold = S.events.filter(e => e.mine).reduce((t, e) => t + soldCount(e), 0);
  const revenue = S.orders.reduce((t, o) => t + o.total, 0);

  return {
    holdLabel: CONFIG.holdMinutes + ' minutes',
    roleTag: S.role === 'organizer' ? 'Host' : 'Attend',
    isAttendee: S.role === 'attendee', isOrganizer: S.role === 'organizer',
    setAttendee: () => setState({ role: 'attendee', view: S.view === 'browse' ? 'browse' : S.view }),
    setOrganizer: () => setState({ role: 'organizer' }),
    segAttendee: seg(S.role === 'attendee'), segOrganizer: seg(S.role === 'organizer'),
    signedIn: !!S.user, signedOut: !S.user,
    initials: S.user ? S.user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : '',
    signOut: () => { setState({ user: null }); say('Signed out.'); },
    toast: S.toast,

    query: S.query, setQuery: e => setState({ query: e.target.value }),
    resultCount: attendeeEvents.length + ' of ' + S.events.length + ' events',
    noResults: attendeeEvents.length === 0,
    clearFilters: () => setState({ query: '', cat: 'All' }),
    cats: cats.map(c => ({ label: c, style: chip(S.cat === c), onClick: () => setState({ cat: c }) })),

    vBrowse: S.role === 'attendee' && S.view === 'browse',
    vEvent: S.role === 'attendee' && S.view === 'event',
    vSeats: S.role === 'attendee' && S.view === 'seats',
    vCheckout: S.role === 'attendee' && S.view === 'checkout',
    vConfirm: S.role === 'attendee' && S.view === 'confirm',
    vMine: S.role === 'attendee' && S.view === 'mine',
    vAuth: S.role === 'attendee' && S.view === 'auth',
    vODash: S.role === 'organizer' && S.oview === 'dash',
    vOCreate: S.role === 'organizer' && S.oview === 'create',
    vOOffer: S.role === 'organizer' && S.oview === 'offer',
    vOStats: S.role === 'organizer' && S.oview === 'stats',
    goBrowse: () => setState({ role: 'attendee', view: 'browse' }),
    goEvent: () => go('event'), goSeats: () => go('seats'),
    goCheckout: () => {
      if (!S.selected.length) return say('Pick at least one seat.');
      setState({ view: 'checkout', f: Object.assign({}, S.f, { name: S.f.name || (S.user ? S.user.name : ''), email: S.f.email || (S.user ? S.user.email : '') }) });
    },
    goMine: () => setState({ role: 'attendee', view: 'mine' }), goAuth: () => setState({ role: 'attendee', view: 'auth' }),
    oDash: () => setState({ role: 'organizer', oview: 'dash' }), oCreate: () => setState({ role: 'organizer', oview: 'create' }),
    oOffer: () => setState({ role: 'organizer', oview: 'offer' }), oStats: () => setState({ role: 'organizer', oview: 'stats' }),
    navDash: navBtn(S.oview === 'dash'), navCreate: navBtn(S.oview === 'create'), navOffer: navBtn(S.oview === 'offer'), navStats: navBtn(S.oview === 'stats'),

    holdActive: !!S.holdStart, timer: Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0'),
    timerPct: Math.round(left / holdMs() * 100) + '%',
    holdCopy: S.selected.length + (S.selected.length === 1 ? ' seat is' : ' seats are') + ' locked to you — completing payment makes the reservation permanent.',
    releaseHold: () => { setState({ selected: [], holdStart: 0, appliedCode: null }); say('Hold released, seats back on sale.'); },

    promo: po ? {
      kicker: po.type === 'percent' ? po.value + '% off' : euro(po.value) + ' off',
      title: (po.type === 'percent' ? po.value + '% off ' : euro(po.value) + ' off ') + (poEvent ? poEvent.title : 'everything we host'),
      body: poEvent ? poEvent.venue + ' · ' + whenLabel(poEvent) + '. Applied automatically when you pick a seat.' : 'Works on any event in the marketplace. Enter the code at checkout.',
      code: po.code, cta: poEvent ? 'See the event' : 'Browse events',
      expiry: po.cap > 0 ? (po.cap - po.used) + ' of ' + po.cap + ' redemptions left' : 'no redemption cap',
      imgLabel: 'promo artwork',
      onOpen: () => poEvent ? openEvent(poEvent.id) : setState({ view: 'browse' }),
      onCopy: () => { setState({ code: po.code }); say(po.code + ' copied into the checkout field.'); }
    } : { kicker: '', title: 'No offers running', body: 'Publish one from the Host side.', code: '—', cta: 'Browse', expiry: '', imgLabel: '', onOpen: () => setState({ view: 'browse' }), onCopy: () => {} },
    promoDots: feat.map((o, i) => ({ w: i === pi ? '18px' : '6px', bg: i === pi ? 'var(--color-accent)' : 'var(--color-neutral-800)', onClick: () => setState({ promo: i }) })),
    promoPrev: () => setState({ promo: (pi - 1 + feat.length) % feat.length }),
    promoNext: () => setState({ promo: (pi + 1) % feat.length }),

    listing: attendeeEvents.map(e => {
      const o = autoOffer(e) || S.offers.find(x => x.active && x.event === 'all');
      const sold = soldCount(e);
      return {
        onOpen: () => openEvent(e.id), title: e.title, venue: e.venue, when: whenLabel(e),
        priceLabel: 'from ' + euro(Math.round(e.price * 0.7)), seatsLeft: (capacity(e) - sold) + ' seats left',
        deal: o ? (o.type === 'percent' ? '−' + o.value + '%' : euro(o.value) + ' off') : '', imgLabel: e.cat
      };
    }),

    ev: (() => {
      const o = autoOffer(ev), sold = soldCount(ev);
      return {
        title: ev.title, cat: ev.cat, venue: ev.venue, about: ev.about,
        meta: whenLabel(ev) + ' · ' + ev.venue,
        deal: !!o, dealCopy: o ? (o.type === 'percent' ? o.value + '% off with ' + o.code : euro(o.value) + ' off with ' + o.code) : '',
        imgLabel: ev.cat + ' · hero image',
        tiers: [
          { name: 'Premium — front rows', note: 'Rows A–B, closest to the stage', price: euro(Math.round(ev.price * 1.6)) },
          { name: 'General — stalls', note: 'Reserved seat, main floor', price: euro(ev.price) },
          { name: 'Gallery', note: 'Rear rows, restricted view', price: euro(Math.round(ev.price * 0.7)) }
        ],
        fromLabel: 'from ' + euro(Math.round(ev.price * 0.7)), fromNote: 'per seat, before fees',
        seatsLeft: (capacity(ev) - sold) + ' of ' + capacity(ev) + ' seats available',
        host: ev.mine ? 'Ribeira Collective' : 'Norte Eventos',
        hostMeta: ev.mine ? '31 events hosted · replies within a day' : '112 events hosted · verified organizer'
      };
    })(),

    seatRows: rows, noneSelected: S.selected.length === 0,
    picked: S.selected.map(k => {
      const [r, c] = k.split('-').map(Number);
      return { label: 'Seat ' + seatLabel(ev, k), tier: tierOf(ev, r).name, price: euro(seatPrice(ev, r)), onRemove: () => pickSeat(ev, r, c) };
    }),
    seatsLabel: S.selected.length + ' × seat (' + S.selected.map(k => seatLabel(ev, k)).join(', ') + ')',
    sub: { label: S.selected.length + (S.selected.length === 1 ? ' seat' : ' seats'), value: euro(m.sub) },
    hasDiscount: m.disc > 0, discountLabel: m.offer ? m.offer.code + (m.offer.type === 'percent' ? ' (−' + m.offer.value + '%)' : ' (−' + euro(m.offer.value) + '/seat)') : '',
    discountValue: '−' + euro(m.disc), feeValue: euro(m.fee), totalValue: euro(m.total),
    holdHint: S.holdStart ? 'The hold does not renew — leaving this page keeps the timer running.' : 'Your ' + CONFIG.holdMinutes + '-minute hold starts with your first seat.',

    f: S.f, code: S.code, err: Object.assign({
      nameBorder: bd(errs.name), emailBorder: bd(errs.email), cardBorder: bd(errs.card), expBorder: bd(errs.exp), cvcBorder: bd(errs.cvc),
      codeBorder: bd(S.codeMsg && !S.codeOk), authBorder: bd(S.authTouched && !EMAIL_RE.test(S.a.email)),
      auth: S.authTouched && !EMAIL_RE.test(S.a.email) ? 'Enter a valid email.' : '',
      nTitleBorder: bd(nErr.nTitle), nVenueBorder: bd(nErr.nVenue), nDateBorder: bd(nErr.nDate), nPriceBorder: bd(nErr.nPrice),
      gCodeBorder: bd(gErr.gCode), gValueBorder: bd(gErr.gValue)
    }, errs, nErr, gErr),
    setName: set('f', 'name'), setEmail: set('f', 'email'), setCard: set('f', 'card'), setExp: set('f', 'exp'), setCvc: set('f', 'cvc'),
    setCode: e => setState({ code: e.target.value, codeMsg: '' }),
    applyCode: () => {
      const res = offerFor(ev, S.code);
      if (!res) return setState({ appliedCode: null, codeMsg: 'No live offer with that code.', codeOk: false });
      if (res.err) return setState({ appliedCode: null, codeMsg: res.err, codeOk: false });
      setState({ appliedCode: res.offer.code, codeOk: true, codeMsg: '✓ ' + res.offer.code + ' applied — ' + (res.offer.type === 'percent' ? res.offer.value + '% off the seat price' : euro(res.offer.value) + ' off each seat') });
    },
    codeMsg: S.codeMsg, codeMsgColor: S.codeOk ? 'var(--color-accent-300)' : 'var(--color-neutral-400)',
    liveCodes: S.offers.filter(o => o.active).map(o => o.code).join(' · '),
    paying: S.paying, payLabel: S.paying ? 'Processing…' : 'Pay ' + euro(m.total) + ' & confirm',
    pay,

    conf: (() => {
      const o = S.lastOrder;
      if (!o) return { headline: 'Reserved', email: '', title: '', when: '', seats: '', venue: '', ref: '', admissions: '' };
      const e = findEvent(o.eventId);
      return { headline: 'Reserved — ' + o.seats + ' ' + (o.seatKeys.length > 1 ? 'are' : 'is') + ' yours', email: o.email, title: e.title, when: whenLabel(e), seats: o.seats, venue: e.venue, ref: o.id, admissions: 'Ticket · ' + o.seatKeys.length + ' admission' + (o.seatKeys.length > 1 ? 's' : '') };
    })(),
    toastCal: () => say('Calendar file downloaded (prototype).'),
    toastPdf: () => say('PDF ticket downloaded (prototype).'),

    mineTabs: [
      { label: 'Upcoming · ' + mineOrders.length, style: chip(S.mineTab === 'upcoming'), onClick: () => setState({ mineTab: 'upcoming' }) },
      { label: 'Expired holds · ' + S.expired.length, style: chip(S.mineTab === 'expired'), onClick: () => setState({ mineTab: 'expired' }) }
    ],
    mineList: S.mineTab === 'upcoming'
      ? mineOrders.map(o => { const e = findEvent(o.eventId); return { title: e.title, when: whenLabel(e) + ' · ' + e.venue, seats: 'Seats ' + o.seats + ' · order ' + o.id, status: 'Confirmed', pill: pill('ok'), total: euro(o.total), action: 'View ticket', onAction: () => setState({ lastOrder: o, view: 'confirm' }) }; })
      : S.expired.map(x => { const e = findEvent(x.eventId); return { title: e.title, when: whenLabel(e) + ' · ' + e.venue, seats: 'Held ' + x.seats + ' — released after ' + CONFIG.holdMinutes + ' min', status: 'Hold expired', pill: pill('quiet'), total: '—', action: 'Try again', onAction: () => openEvent(x.eventId) }; }),
    mineEmpty: (S.mineTab === 'upcoming' ? mineOrders.length : S.expired.length) === 0,
    hasOrders: mineOrders.length > 0, noOrders: mineOrders.length === 0, orderCount: mineOrders.length,

    a: S.a, setAuthName: set('a', 'name'), setAuthEmail: set('a', 'email'),
    doSignIn: () => {
      setState({ authTouched: true });
      if (!EMAIL_RE.test(S.a.email)) return say('That email does not look right.');
      setState({ user: { name: S.a.name.trim() || 'Guest attendee', email: S.a.email.trim() }, view: 'browse', authTouched: false });
      say('Signed in — your details will prefill at checkout.');
    },

    orgName: 'Ribeira Collective',
    kpis: [
      { label: 'Seats sold', value: String(mySold), note: 'across ' + S.events.filter(e => e.mine).length + ' live events' },
      { label: 'Prototype revenue', value: euro(revenue), note: S.orders.length + ' order' + (S.orders.length === 1 ? '' : 's') + ' this session' },
      { label: 'Offer redemptions', value: String(S.offers.reduce((t, o) => t + o.used, 0)), note: S.offers.filter(o => o.active).length + ' codes live' },
      { label: 'Holds expiring', value: Math.round(expiredTotal / holdsStarted * 100) + '%', note: 'unpaid after the window' }
    ],
    myEvents: S.events.filter(e => e.mine).map(e => {
      const sold = soldCount(e), pct = Math.round(sold / capacity(e) * 100);
      return {
        id: e.id, title: e.title, when: whenLabel(e), state: 'Published', pill: pill('ok'),
        soldCopy: sold + ' of ' + capacity(e) + ' seats sold', pctLabel: pct + '%', pct: pct + '%',
        holdCopy: (S.holdStart && S.holdEvent === e.id ? S.selected.length : 0) + ' seats on hold right now',
        onPreview: () => openEvent(e.id), onOffer: () => setState({ role: 'organizer', oview: 'offer', g: Object.assign({}, S.g, { event: e.id }) })
      };
    }),
    offerList: S.offers.map(o => ({
      code: o.code, detail: (o.type === 'percent' ? o.value + '% off' : euro(o.value) + ' off') + ' · ' + (o.event === 'all' ? 'all events' : findEvent(o.event).title.slice(0, 22)) + (o.featured ? ' · featured' : ''),
      used: o.cap > 0 ? o.used + '/' + o.cap : String(o.used),
      toggleLabel: o.active ? 'Pause' : 'Resume',
      onToggle: () => { setState(s => ({ offers: s.offers.map(x => x.code === o.code ? Object.assign({}, x, { active: !x.active }) : x) })); say(o.code + (o.active ? ' paused — no longer redeemable.' : ' resumed.')); }
    })),
    orderRows: S.orders.slice().reverse().map(o => ({ buyer: o.buyer || 'Guest', event: findEvent(o.eventId).title, seats: o.seats, code: o.code, total: euro(o.total), status: o.status, pill: pill('ok') })),

    n: S.n, catOptions: ['Live music', 'Conference', 'Sports', 'Comedy', 'Workshop', 'Community'],
    setNTitle: set('n', 'title'), setNCat: set('n', 'cat'), setNVenue: set('n', 'venue'), setNDate: set('n', 'date'),
    setNTime: set('n', 'time'), setNAbout: set('n', 'about'), setNPrice: set('n', 'price'), setNRows: set('n', 'rows'), setNCols: set('n', 'cols'),
    holdOptions: [5, 10, 15].map(h => ({ label: h + ' min', style: seg(S.n.hold === h), onClick: () => setState({ n: Object.assign({}, S.n, { hold: h }) }) })),
    publishEvent,
    resetEvent: () => setState({ n: { title: '', cat: 'Live music', venue: '', date: '', time: '20:30', about: '', price: '38', rows: '8', cols: '16', hold: 5 }, nTouched: false }),
    preview: {
      when: S.n.date ? whenLabel({ date: S.n.date, time: S.n.time || '20:00' }) : 'date not set',
      title: S.n.title.trim() || 'Untitled event', venue: S.n.venue.trim() || 'Venue not set',
      price: 'from ' + euro(Math.round((Number(S.n.price) || 0) * 0.7)),
      capacity: ((Number(S.n.rows) || 0) * (Number(S.n.cols) || 0)) + ' seats'
    },

    g: S.g, valueLabel: S.g.type === 'fixed' ? 'Amount off per seat (€)' : 'Percent off (%)',
    offerTypes: [
      { key: 'percent', label: 'Percent off', note: 'a share of the seat price' },
      { key: 'fixed', label: 'Fixed amount', note: 'euros off each seat' },
      { key: 'code', label: 'Promo code only', note: 'hidden from the carousel' }
    ].map(t => ({ label: t.label, note: t.note, style: card(S.g.type === t.key), onClick: () => setState({ g: Object.assign({}, S.g, { type: t.key, featured: t.key === 'code' ? false : S.g.featured }) }) })),
    setGValue: set('g', 'value'), setGCode: set('g', 'code', v => v.toUpperCase()), setGCap: set('g', 'cap'), setGEvent: set('g', 'event'),
    toggleFeatured: () => setState({ g: Object.assign({}, S.g, { featured: !S.g.featured }) }),
    featuredStyle: 'display:flex;align-items:center;gap:var(--space-4);padding:var(--space-4) var(--space-6);border-radius:var(--radius-md);cursor:pointer;background:transparent;border:1px solid ' + (S.g.featured ? 'var(--color-accent)' : 'var(--color-neutral-800)'),
    featuredBox: 'width:16px;height:16px;flex:none;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;border:1px solid ' + (S.g.featured ? 'var(--color-accent)' : 'var(--color-neutral-700)') + ';background:' + (S.g.featured ? 'var(--color-accent)' : 'transparent') + ';color:' + (S.g.featured ? 'var(--color-accent-900)' : 'transparent'),
    publishOffer,
    gPreview: (() => {
      const base = 90, v = Number(S.g.value) || 0;
      const d = S.g.type === 'fixed' ? Math.min(base, v * 2) : base * v / 100;
      return {
        title: (S.g.type === 'fixed' ? euro(v) + ' off' : v + '% off') + ' ' + (S.g.event === 'all' ? 'every event we host' : findEvent(S.g.event).title),
        body: 'Code ' + (S.g.code.trim() || '—') + ' · ' + ((Number(S.g.cap) || 0) > 0 ? S.g.cap + ' redemptions' : 'no cap'),
        base: euro(base), lineLabel: (S.g.code.trim() || 'CODE') + (S.g.type === 'fixed' ? ' (−' + euro(v) + '/seat)' : ' (−' + v + '%)'),
        lineValue: '−' + euro(d), total: euro(Math.max(0, base - d) + CONFIG.serviceFee * 2)
      };
    })(),

    bars: barSeed.map((h, i) => {
      const isToday = i === barSeed.length - 1;
      const extra = isToday ? S.orders.reduce((t, o) => t + o.seatKeys.length, 0) * 6 : 0;
      return { h: Math.min(170, h + extra) + 'px', fill: i % 3 === 1 || (isToday && S.orders.some(o => o.code !== '—')) ? 'var(--color-accent)' : 'var(--color-neutral-800)', title: (h + extra) + ' seats' };
    }),
    funnel: [
      { label: 'Seat selected', value: String(holdsStarted + 338), pct: '100%' },
      { label: 'Held (' + CONFIG.holdMinutes + ' min)', value: String(holdsStarted), pct: Math.round(holdsStarted / (holdsStarted + 338) * 100) + '%' },
      { label: 'Payment started', value: String(started), pct: Math.round(started / (holdsStarted + 338) * 100) + '%' },
      { label: 'Paid — permanent', value: String(paid), pct: Math.round(paid / (holdsStarted + 338) * 100) + '%' }
    ],
    funnelNote: Math.round(expiredTotal / holdsStarted * 100) + '% of holds expire unpaid — the ' + CONFIG.holdMinutes + '-minute window is where the drop-off sits.',
    offerPerf: S.offers.map(o => ({
      code: o.code, type: o.type === 'percent' ? 'Percent' : 'Fixed', redeemed: String(o.used),
      given: o.type === 'percent' ? euro(o.used * 18) : euro(o.used * o.value), net: o.used ? euro(o.used * 52) : '—'
    }))
  };
}

/* ───────────────────────────── markup ───────────────────────────── */

const fieldError = msg => msg ? html`<div style="font-size:11.5px;color:var(--color-accent-300);margin-top:4px">${msg}</div>` : '';
const MONO = 'font-family:ui-monospace,Menlo,monospace';

function header(v) {
  return html`
<div data-key="nav" style="position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:var(--space-6);padding:var(--space-4) var(--space-8);background:color-mix(in srgb, var(--color-bg) 88%, transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--color-divider)">
  <button data-click="${v.goBrowse}" style="display:flex;align-items:baseline;gap:6px;border:0;background:none;cursor:pointer;padding:0;font-family:var(--font-heading);font-weight:500;font-size:17px;letter-spacing:-.02em;color:var(--color-text)">Gather<span style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent)">${v.roleTag}</span></button>
  ${v.isAttendee ? html`
  <div style="flex:1;display:flex;align-items:center;gap:var(--space-4);min-width:0">
    <input value="${v.query}" data-input="${v.setQuery}" placeholder="Search events, venues, cities" class="input" style="flex:1;min-width:0;max-width:420px;font-size:13px">
    <button data-click="${v.goBrowse}" class="btn btn-ghost" style="font-size:13px">Browse</button>
    <button data-click="${v.goMine}" class="btn btn-ghost" style="font-size:13px">Reservations ${v.hasOrders ? html`<span class="tag tag-accent" style="margin-left:5px;font-size:10px">${v.orderCount}</span>` : ''}</button>
  </div>` : ''}
  ${v.isOrganizer ? html`
  <div style="flex:1;display:flex;align-items:center;gap:var(--space-2);min-width:0;overflow:auto">
    <button data-click="${v.oDash}" style="${v.navDash}">Dashboard</button>
    <button data-click="${v.oCreate}" style="${v.navCreate}">Host an event</button>
    <button data-click="${v.oOffer}" style="${v.navOffer}">Offers</button>
    <button data-click="${v.oStats}" style="${v.navStats}">Analytics</button>
  </div>` : ''}
  <div style="display:flex;align-items:center;gap:var(--space-3)">
    <div class="seg" style="font-size:12px">
      <button data-click="${v.setAttendee}" style="${v.segAttendee}">Attend</button>
      <button data-click="${v.setOrganizer}" style="${v.segOrganizer}">Host</button>
    </div>
    ${v.signedIn ? html`<div style="display:flex;align-items:center;gap:7px"><div style="width:26px;height:26px;border-radius:50%;background:var(--color-accent-800);color:var(--color-accent-200);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500">${v.initials}</div><button data-click="${v.signOut}" class="btn btn-ghost" style="font-size:12px">Sign out</button></div>` : ''}
    ${v.signedOut ? html`<button data-click="${v.goAuth}" class="btn btn-primary" style="font-size:13px">Sign in</button>` : ''}
  </div>
</div>
${v.holdActive ? html`
<div data-key="hold" style="position:sticky;top:57px;z-index:35;display:flex;align-items:center;gap:var(--space-4);padding:var(--space-3) var(--space-8);background:var(--color-accent-900);border-bottom:1px solid var(--color-accent-700)">
  <div style="font-family:var(--font-heading);font-weight:500;font-size:14px;color:var(--color-accent-200);font-variant-numeric:tabular-nums">${v.timer}</div>
  <div style="flex:1;font-size:12.5px;color:var(--color-accent-300)">${v.holdCopy}</div>
  <div style="width:180px;height:3px;border-radius:2px;background:var(--color-accent-800);overflow:hidden"><div style="height:100%;background:var(--color-accent);width:${v.timerPct}"></div></div>
  <button data-click="${v.releaseHold}" class="btn btn-ghost" style="font-size:12px;color:var(--color-accent-300)">Release</button>
</div>` : ''}`;
}

function browseView(v) {
  return html`
<div class="pane" data-key="browse" style="display:flex;flex-direction:column;gap:var(--space-8)">
  <div style="display:flex;align-items:stretch;gap:var(--space-4)">
    <button data-click="${v.promoPrev}" class="btn btn-icon lift" style="align-self:center;border:1px solid var(--color-neutral-800)">‹</button>
    <div style="flex:1;min-width:0;display:flex;gap:var(--space-8);align-items:center;padding:var(--space-8);border:1px solid var(--color-accent-800);border-radius:var(--radius-lg);background:linear-gradient(100deg, var(--color-accent-900), var(--color-surface) 70%)">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--space-3)">
        <div style="display:flex;align-items:center;gap:var(--space-3)"><span class="tag tag-accent" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase">${v.promo.kicker}</span><span style="font-size:11.5px;color:var(--color-neutral-500)">${v.promo.expiry}</span></div>
        <h2 style="font-size:28px;margin:0">${v.promo.title}</h2>
        <div style="font-size:13.5px;color:var(--color-neutral-400);max-width:52ch">${v.promo.body}</div>
        <div style="display:flex;align-items:center;gap:var(--space-4);margin-top:var(--space-2)">
          <button data-click="${v.promo.onOpen}" class="btn btn-primary">${v.promo.cta}</button>
          <button data-click="${v.promo.onCopy}" class="btn btn-secondary" style="${MONO};font-size:13px">${v.promo.code} · copy</button>
        </div>
      </div>
      <div style="width:220px;height:130px;flex:none;border-radius:var(--radius-md);border:1px solid var(--color-neutral-800);background:linear-gradient(140deg, var(--color-section), var(--color-neutral-900));display:flex;align-items:flex-end;padding:var(--space-4);font-size:11px;color:var(--color-neutral-500)">${v.promo.imgLabel}</div>
    </div>
    <button data-click="${v.promoNext}" class="btn btn-icon lift" style="align-self:center;border:1px solid var(--color-neutral-800)">›</button>
  </div>
  <div style="display:flex;gap:6px;justify-content:center;margin-top:calc(-1 * var(--space-6))">
    ${v.promoDots.map(d => html`<button data-click="${d.onClick}" style="width:${d.w};height:4px;border:0;border-radius:2px;padding:0;cursor:pointer;background:${d.bg}"></button>`)}
  </div>

  <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center">
    ${v.cats.map(c => html`<button data-click="${c.onClick}" style="${c.style}">${c.label}</button>`)}
    <div style="margin-left:auto;font-size:12px;color:var(--color-neutral-500)">${v.resultCount}</div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:var(--space-6)">
    ${v.listing.map(e => html`
    <button data-click="${e.onOpen}" class="card lift" style="text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:var(--space-3);padding:0;overflow:hidden;border:1px solid var(--color-neutral-800)">
      <div style="height:120px;background:linear-gradient(135deg, var(--color-neutral-900), var(--color-section-ghost));display:flex;align-items:flex-end;justify-content:space-between;padding:var(--space-3) var(--space-4);gap:8px">
        <span style="font-size:10.5px;color:var(--color-neutral-400)">${e.imgLabel}</span>
        ${e.deal ? html`<span class="tag tag-accent" style="font-size:10px">${e.deal}</span>` : ''}
      </div>
      <div style="padding:0 var(--space-6) var(--space-6);display:flex;flex-direction:column;gap:var(--space-2)">
        <div class="card-kicker" style="font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500)">${e.when}</div>
        <div class="card-title" style="font-family:var(--font-heading);font-weight:500;font-size:16px">${e.title}</div>
        <div style="font-size:12.5px;color:var(--color-neutral-400)">${e.venue}</div>
        <div style="display:flex;align-items:baseline;gap:var(--space-3);margin-top:var(--space-2)">
          <div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${e.priceLabel}</div>
          <div style="font-size:11.5px;color:var(--color-neutral-500)">${e.seatsLeft}</div>
          <div style="margin-left:auto;font-size:12px;color:var(--color-accent)">Reserve →</div>
        </div>
      </div>
    </button>`)}
  </div>
  ${v.noResults ? html`<div style="padding:var(--space-8);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);text-align:center;color:var(--color-neutral-500);font-size:13px">Nothing matches that search. <button data-click="${v.clearFilters}" class="btn btn-ghost" style="font-size:13px">Clear filters</button></div>` : ''}
</div>`;
}

function eventView(v) {
  const ev = v.ev;
  return html`
<div class="pane" data-key="event" style="display:flex;flex-direction:column;gap:var(--space-6)">
  <button data-click="${v.goBrowse}" class="btn btn-ghost" style="align-self:flex-start;font-size:12.5px">← All events</button>
  <div style="height:220px;border-radius:var(--radius-lg);border:1px solid var(--color-neutral-800);background:linear-gradient(120deg, var(--color-section), var(--color-neutral-900) 70%);display:flex;align-items:flex-end;padding:var(--space-6);font-size:11px;color:var(--color-neutral-500)">${ev.imgLabel}</div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
    <div style="flex:1;min-width:300px;display:flex;flex-direction:column;gap:var(--space-6)">
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2)">${ev.deal ? html`<span class="tag tag-accent" style="font-size:11px">${ev.dealCopy}</span>` : ''}<span class="tag tag-outline" style="font-size:11px">${ev.cat}</span></div>
        <h1 style="font-size:34px;margin:0">${ev.title}</h1>
        <div style="font-size:13.5px;color:var(--color-neutral-400)">${ev.meta}</div>
      </div>
      <div style="font-size:13.5px;line-height:1.7;color:var(--color-neutral-300);max-width:64ch">${ev.about}</div>
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <h4 style="font-size:15px;margin:0">Ticket tiers</h4>
        ${ev.tiers.map(t => html`
        <div style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-4) var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
          <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:14px">${t.name}</div><div style="font-size:12px;color:var(--color-neutral-500)">${t.note}</div></div>
          <div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${t.price}</div>
        </div>`)}
      </div>
      <div style="display:flex;gap:var(--space-4);align-items:center;padding:var(--space-4) var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md)">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--color-neutral-900);border:1px solid var(--color-neutral-800)"></div>
        <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${ev.host}</div><div style="font-size:12px;color:var(--color-neutral-500)">${ev.hostMeta}</div></div>
      </div>
    </div>
    <div style="width:320px;flex:none;position:sticky;top:90px;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-md)">
      <div style="display:flex;align-items:baseline;gap:var(--space-3)"><div style="font-family:var(--font-heading);font-weight:500;font-size:26px">${ev.fromLabel}</div><div style="font-size:12px;color:var(--color-neutral-500)">${ev.fromNote}</div></div>
      <div style="height:1px;background:var(--color-divider)"></div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--color-neutral-400)">
        <div>${ev.seatsLeft}</div>
        <div>Reserved seating · pick your own seats</div>
        <div>Mobile ticket, QR entry at the door</div>
      </div>
      <button data-click="${v.goSeats}" class="btn btn-primary btn-block">Choose seats</button>
      <div style="font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Seats are held for ${v.holdLabel} while you pay. The reservation becomes permanent the moment payment completes.</div>
    </div>
  </div>
</div>`;
}

function totalsBlock(v, firstLabel, totalLabel, totalSize) {
  return html`
<div style="display:flex;flex-direction:column;gap:5px;font-size:12.5px">
  <div style="display:flex;justify-content:space-between;color:var(--color-neutral-400)"><span>${firstLabel}</span><span>${v.sub.value}</span></div>
  ${v.hasDiscount ? html`<div style="display:flex;justify-content:space-between;color:var(--color-accent-300)"><span>${v.discountLabel}</span><span>${v.discountValue}</span></div>` : ''}
  <div style="display:flex;justify-content:space-between;color:var(--color-neutral-400)"><span>Service fee</span><span>${v.feeValue}</span></div>
  <div style="display:flex;justify-content:space-between;padding-top:var(--space-3);margin-top:var(--space-2);border-top:1px solid var(--color-divider);font-family:var(--font-heading);font-weight:500;font-size:${totalSize}"><span>${totalLabel}</span><span>${v.totalValue}</span></div>
</div>`;
}

function seatsView(v) {
  const legend = (style, label) => html`<div style="display:flex;align-items:center;gap:5px"><span style="width:11px;height:11px;border-radius:3px;${style}"></span>${label}</div>`;
  return html`
<div class="pane" data-key="seats" style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
  <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-6)">
    <div style="display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap">
      <button data-click="${v.goEvent}" class="btn btn-ghost" style="font-size:12.5px">← ${v.ev.title}</button>
      <div style="margin-left:auto;display:flex;gap:var(--space-4);flex-wrap:wrap;font-size:11.5px;color:var(--color-neutral-400)">
        ${legend('border:1px solid var(--color-neutral-600)', 'Free')}
        ${legend('background:var(--color-accent)', 'Yours')}
        ${legend('background:var(--color-accent-800)', 'Held')}
        ${legend('background:var(--color-neutral-800)', 'Sold')}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:var(--space-6);padding:var(--space-8) var(--space-4);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);overflow:auto">
      <div style="width:min(420px,90%);height:26px;border-radius:200px 200px 0 0;border:1px solid var(--color-neutral-700);background:linear-gradient(var(--color-neutral-900),transparent);display:flex;align-items:center;justify-content:center;font-size:10.5px;letter-spacing:.2em;color:var(--color-neutral-400)">STAGE</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${v.seatRows.map(row => html`
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:16px;font-size:10px;color:var(--color-neutral-600)">${row.label}</div>
          ${row.seats.map(s => html`<button data-click="${s.onClick}" title="${s.title}" class="seat" style="width:18px;height:16px;border-radius:3px;padding:0;cursor:${s.cursor};background:${s.fill};border:1px solid ${s.border}"></button>`)}
          <div style="width:16px;font-size:10px;color:var(--color-neutral-600)">${row.tierMark}</div>
        </div>`)}
      </div>
      <div style="font-size:11.5px;color:var(--color-neutral-500)">Front rows are premium · tap a seat to add or drop it</div>
    </div>
  </div>
  <div style="width:320px;flex:none;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-md)">
    <h4 style="font-size:15px;margin:0">Your selection</h4>
    ${v.noneSelected ? html`<div style="padding:var(--space-6);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);font-size:12.5px;color:var(--color-neutral-500);text-align:center">Pick a seat to start your ${v.holdLabel} hold.</div>` : ''}
    ${v.picked.map(p => html`
    <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md)">
      <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${p.label}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">${p.tier}</div></div>
      <div style="font-size:13.5px">${p.price}</div>
      <button data-click="${p.onRemove}" class="btn btn-ghost" style="font-size:12px;padding:2px 6px;color:var(--color-neutral-500)">✕</button>
    </div>`)}
    <div style="height:1px;background:var(--color-divider)"></div>
    ${totalsBlock(v, v.sub.label, 'Total', '16px')}
    <button data-click="${v.goCheckout}" ${v.noneSelected ? html`disabled` : ''} class="btn btn-primary btn-block">Continue to payment</button>
    <div style="font-size:11.5px;color:var(--color-neutral-500)">${v.holdHint}</div>
  </div>
</div>`;
}

function checkoutView(v) {
  const field = (label, value, onInput, placeholder, border, error) => html`
<div class="field"><label>${label}</label><input value="${value}" data-input="${onInput}" class="input" placeholder="${placeholder}" style="border-color:${border}">${fieldError(error)}</div>`;
  return html`
<div class="pane" data-key="checkout" style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
  <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-6)">
    <h1 style="font-size:28px;margin:0">Checkout</h1>
    <div style="display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">1 · Contact</h6>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--space-4)">
        ${field('Full name', v.f.name, v.setName, 'Ana Ferreira', v.err.nameBorder, v.err.name)}
        ${field('Email for the ticket', v.f.email, v.setEmail, 'you@example.com', v.err.emailBorder, v.err.email)}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:var(--space-3)">
      <h6 style="margin:0;color:var(--color-neutral-500)">2 · Discount</h6>
      <div style="display:flex;gap:var(--space-3);align-items:flex-start;flex-wrap:wrap">
        <input value="${v.code}" data-input="${v.setCode}" class="input" placeholder="Promo code" style="flex:1;min-width:160px;${MONO};text-transform:uppercase;border-color:${v.err.codeBorder}">
        <button data-click="${v.applyCode}" class="btn btn-secondary">Apply</button>
      </div>
      ${v.codeMsg ? html`<div style="font-size:12px;color:${v.codeMsgColor}">${v.codeMsg}</div>` : ''}
      <div style="font-size:11.5px;color:var(--color-neutral-600)">Live codes in this prototype: ${v.liveCodes}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">3 · Payment</h6>
      ${field('Card number', v.f.card, v.setCard, '4242 4242 4242 4242', v.err.cardBorder, v.err.card)}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:var(--space-4)">
        ${field('Expiry', v.f.exp, v.setExp, 'MM/YY', v.err.expBorder, v.err.exp)}
        ${field('CVC', v.f.cvc, v.setCvc, '123', v.err.cvcBorder, v.err.cvc)}
      </div>
    </div>
  </div>
  <div style="width:330px;flex:none;position:sticky;top:110px;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-md)">
    <div style="display:flex;flex-direction:column;gap:4px"><div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${v.ev.title}</div><div style="font-size:12px;color:var(--color-neutral-500)">${v.ev.meta}</div></div>
    <div style="height:1px;background:var(--color-divider)"></div>
    ${totalsBlock(v, v.seatsLabel, 'Pay now', '18px')}
    <button data-click="${v.pay}" ${v.paying ? html`disabled` : ''} class="btn btn-primary btn-block">${v.payLabel}</button>
    <div style="font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Payment converts the ${v.holdLabel} hold into a permanent reservation.</div>
    <button data-click="${v.goSeats}" class="btn btn-ghost" style="font-size:12px;align-self:flex-start">← Change seats</button>
  </div>
</div>`;
}

function confirmView(v) {
  const c = v.conf;
  const cell = (label, value) => html`<div><div style="font-size:11px;color:var(--color-neutral-500)">${label}</div><div>${value}</div></div>`;
  return html`
<div class="pane" data-key="confirm" style="display:flex;flex-direction:column;align-items:center;gap:var(--space-8);padding-top:var(--space-8)">
  <div style="display:flex;flex-direction:column;align-items:center;gap:var(--space-3);text-align:center">
    <div style="width:44px;height:44px;border-radius:50%;border:1px solid var(--color-accent);color:var(--color-accent);display:flex;align-items:center;justify-content:center;font-size:19px">✓</div>
    <h1 style="font-size:28px;margin:0">${c.headline}</h1>
    <div style="font-size:13.5px;color:var(--color-neutral-400);max-width:56ch">Payment cleared, so the hold is gone — these seats are yours permanently. Ticket sent to ${c.email}.</div>
  </div>
  <div style="display:flex;flex-wrap:wrap;width:min(660px,100%);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);overflow:hidden;box-shadow:var(--shadow-md)">
    <div style="flex:1;min-width:260px;padding:var(--space-8);display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">${c.admissions}</h6>
      <div style="font-family:var(--font-heading);font-weight:500;font-size:19px">${c.title}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);font-size:13px">
        ${cell('When', c.when)}${cell('Seats', c.seats)}${cell('Venue', c.venue)}${cell('Order', c.ref)}
      </div>
      <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-2)"><button data-click="${v.toastCal}" class="btn btn-secondary" style="font-size:12.5px">Add to calendar</button><button data-click="${v.toastPdf}" class="btn btn-secondary" style="font-size:12.5px">Download PDF</button></div>
    </div>
    <div style="width:190px;flex:none;padding:var(--space-8);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-3);border-left:1px solid var(--color-divider)">
      <div style="width:120px;height:120px;border-radius:var(--radius-sm);background:repeating-conic-gradient(var(--color-neutral-100) 0 25%, var(--color-neutral-900) 0 50%) 0/15px 15px"></div>
      <div style="font-size:11px;color:var(--color-neutral-500)">Scan at the door</div>
    </div>
  </div>
  <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;justify-content:center"><button data-click="${v.goMine}" class="btn btn-primary">View my reservations</button><button data-click="${v.goBrowse}" class="btn btn-secondary">Keep browsing</button></div>
</div>`;
}

function mineView(v) {
  return html`
<div class="pane" data-key="mine" style="display:flex;flex-direction:column;gap:var(--space-6)">
  <h1 style="font-size:28px;margin:0">My reservations</h1>
  <div style="display:flex;gap:var(--space-2)">${v.mineTabs.map(t => html`<button data-click="${t.onClick}" style="${t.style}">${t.label}</button>`)}</div>
  ${v.mineEmpty ? html`<div style="padding:var(--space-8);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);text-align:center;font-size:13px;color:var(--color-neutral-500)">Nothing here yet. <button data-click="${v.goBrowse}" class="btn btn-ghost" style="font-size:13px">Find an event</button></div>` : ''}
  ${v.mineList.map(r => html`
  <div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
    <div style="width:72px;height:56px;flex:none;border-radius:var(--radius-sm);background:linear-gradient(135deg, var(--color-neutral-900), var(--color-section-ghost))"></div>
    <div style="flex:1;min-width:180px"><div style="font-family:var(--font-heading);font-weight:500;font-size:14.5px">${r.title}</div><div style="font-size:12px;color:var(--color-neutral-400)">${r.when}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">${r.seats}</div></div>
    <span style="${r.pill}">${r.status}</span>
    <div style="font-family:var(--font-heading);font-weight:500;font-size:14px">${r.total}</div>
    <button data-click="${r.onAction}" class="btn btn-secondary" style="font-size:12.5px">${r.action}</button>
  </div>`)}
</div>`;
}

function authView(v) {
  return html`
<div class="pane" data-key="auth" style="display:flex;justify-content:center;padding-top:var(--space-8)">
  <div style="width:min(400px,100%);display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-8);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-md)">
    <h1 style="font-size:24px;margin:0">Sign in to reserve</h1>
    <div style="font-size:12.5px;line-height:1.6;color:var(--color-neutral-400)">Signing in first means the ${v.holdLabel} hold is never spent on account setup.</div>
    <div class="field"><label>Name</label><input value="${v.a.name}" data-input="${v.setAuthName}" class="input" placeholder="Ana Ferreira"></div>
    <div class="field"><label>Email</label><input value="${v.a.email}" data-input="${v.setAuthEmail}" class="input" placeholder="you@example.com" style="border-color:${v.err.authBorder}">${fieldError(v.err.auth)}</div>
    <button data-click="${v.doSignIn}" class="btn btn-primary btn-block">Continue</button>
    <button data-click="${v.goBrowse}" class="btn btn-ghost" style="font-size:12.5px">Keep browsing as a guest</button>
  </div>
</div>`;
}

function dashView(v) {
  return html`
<div class="pane" data-key="dash" style="display:flex;flex-direction:column;gap:var(--space-8)">
  <div style="display:flex;align-items:baseline;gap:var(--space-4);flex-wrap:wrap"><h1 style="font-size:28px;margin:0">Dashboard</h1><div style="font-size:12.5px;color:var(--color-neutral-500)">${v.orgName} · live prototype data</div><button data-click="${v.oCreate}" class="btn btn-primary" style="margin-left:auto">+ Host an event</button></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--space-4)">
    ${v.kpis.map(k => html`
    <div style="padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface);display:flex;flex-direction:column;gap:5px"><h6 style="margin:0;color:var(--color-neutral-500)">${k.label}</h6><div style="font-family:var(--font-heading);font-weight:500;font-size:26px">${k.value}</div><div style="font-size:11.5px;color:var(--color-accent-300)">${k.note}</div></div>`)}
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-6);align-items:flex-start">
    <div style="flex:1;min-width:300px;display:flex;flex-direction:column;gap:var(--space-4)">
      <h4 style="font-size:16px;margin:0">Your events</h4>
      ${v.myEvents.map(e => html`
      <div style="display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
        <div style="display:flex;align-items:baseline;gap:var(--space-3);flex-wrap:wrap"><div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${e.title}</div><span style="${e.pill}">${e.state}</span><div style="margin-left:auto;font-size:12px;color:var(--color-neutral-500)">${e.when}</div></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--color-neutral-400)"><span>${e.soldCopy}</span><span>${e.pctLabel}</span></div>
        <div style="height:5px;border-radius:3px;background:var(--color-neutral-900);overflow:hidden"><div style="height:100%;background:var(--color-accent);width:${e.pct}"></div></div>
        <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:center"><div style="font-size:11.5px;color:var(--color-neutral-500)">${e.holdCopy}</div><button data-click="${e.onPreview}" class="btn btn-ghost" style="font-size:12px;margin-left:auto">Preview as attendee</button><button data-click="${e.onOffer}" class="btn btn-secondary" style="font-size:12px">Add an offer</button></div>
      </div>`)}
    </div>
    <div style="width:320px;flex:none;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
      <h4 style="font-size:16px;margin:0">Active offers</h4>
      ${v.offerList.map(o => html`
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-sm)">
        <div style="flex:1;min-width:0"><div style="${MONO};font-size:12.5px">${o.code}</div><div style="font-size:11px;color:var(--color-neutral-500)">${o.detail}</div></div>
        <div style="font-size:11.5px;color:var(--color-accent-300)">${o.used}</div>
        <button data-click="${o.onToggle}" class="btn btn-ghost" style="font-size:11px;color:var(--color-neutral-500)">${o.toggleLabel}</button>
      </div>`)}
      <button data-click="${v.oOffer}" class="btn btn-primary btn-block" style="font-size:12.5px">+ New offer</button>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:var(--space-4)">
    <h4 style="font-size:16px;margin:0">Orders</h4>
    ${v.noOrders ? html`<div style="padding:var(--space-8);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);font-size:13px;color:var(--color-neutral-500);text-align:center">No orders yet — switch to Attend, reserve a seat, and it lands here.</div>` : ''}
    ${v.hasOrders ? html`
    <table class="table" style="width:100%">
      <thead><tr><th>Buyer</th><th>Event</th><th>Seats</th><th>Code</th><th>Total</th><th>Status</th></tr></thead>
      <tbody>
        ${v.orderRows.map(o => html`<tr><td>${o.buyer}</td><td>${o.event}</td><td>${o.seats}</td><td style="${MONO}">${o.code}</td><td>${o.total}</td><td><span style="${o.pill}">${o.status}</span></td></tr>`)}
      </tbody>
    </table>` : ''}
  </div>
</div>`;
}

function createView(v) {
  return html`
<div class="pane" data-key="create" style="display:flex;flex-direction:column;gap:var(--space-6)">
  <h1 style="font-size:28px;margin:0">Host an event</h1>
  <div style="font-size:13px;color:var(--color-neutral-400)">Publishing adds it to the attendee browse list immediately, with a real seat map at the size you set.</div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
    <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-4)">
      <div class="field"><label>Event title</label><input value="${v.n.title}" data-input="${v.setNTitle}" class="input" placeholder="Autumn Sessions — Night Five" style="border-color:${v.err.nTitleBorder}">${fieldError(v.err.nTitle)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:var(--space-4)">
        <div class="field"><label>Category</label><select data-input="${v.setNCat}" data-value="${v.n.cat}" class="input">${v.catOptions.map(c => html`<option value="${c}">${c}</option>`)}</select></div>
        <div class="field"><label>Venue</label><input value="${v.n.venue}" data-input="${v.setNVenue}" class="input" placeholder="Teatro Sá da Bandeira" style="border-color:${v.err.nVenueBorder}"></div>
        <div class="field"><label>Date</label><input value="${v.n.date}" data-input="${v.setNDate}" type="date" class="input" style="border-color:${v.err.nDateBorder}"></div>
        <div class="field"><label>Start time</label><input value="${v.n.time}" data-input="${v.setNTime}" type="time" class="input"></div>
      </div>
      <div class="field"><label>Description</label><textarea data-input="${v.setNAbout}" class="input" rows="3" placeholder="What happens, doors, running time">${v.n.about}</textarea></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-4)">
        <div class="field"><label>General price (€)</label><input value="${v.n.price}" data-input="${v.setNPrice}" type="number" class="input" style="border-color:${v.err.nPriceBorder}">${fieldError(v.err.nPrice)}</div>
        <div class="field"><label>Rows</label><input value="${v.n.rows}" data-input="${v.setNRows}" type="number" class="input"></div>
        <div class="field"><label>Seats per row</label><input value="${v.n.cols}" data-input="${v.setNCols}" type="number" class="input"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-2)"><label style="font-size:12px;color:var(--color-neutral-400)">Seat hold window</label><div class="seg" style="align-self:flex-start">${v.holdOptions.map(h => html`<button data-click="${h.onClick}" style="${h.style}">${h.label}</button>`)}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">Unpaid holds return to sale automatically when the window closes.</div></div>
      <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;padding-top:var(--space-2)"><button data-click="${v.publishEvent}" class="btn btn-primary">Publish event</button><button data-click="${v.resetEvent}" class="btn btn-ghost">Reset form</button></div>
    </div>
    <div style="width:320px;flex:none;display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Live preview — browse card</h6>
      <div style="border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface);overflow:hidden">
        <div style="height:96px;background:linear-gradient(135deg, var(--color-neutral-900), var(--color-section-ghost))"></div>
        <div style="padding:var(--space-6);display:flex;flex-direction:column;gap:var(--space-2)"><h6 style="margin:0;color:var(--color-neutral-500)">${v.preview.when}</h6><div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${v.preview.title}</div><div style="font-size:12px;color:var(--color-neutral-400)">${v.preview.venue}</div><div style="display:flex;gap:var(--space-3);align-items:baseline;margin-top:var(--space-2)"><div style="font-family:var(--font-heading);font-weight:500;font-size:14px">${v.preview.price}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">${v.preview.capacity}</div></div></div>
      </div>
      <div style="padding:var(--space-4);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Publishing runs three checks: a title, a venue and date, and a price above zero.</div>
    </div>
  </div>
</div>`;
}

function offerView(v) {
  return html`
<div class="pane" data-key="offer" style="display:flex;flex-direction:column;gap:var(--space-6)">
  <h1 style="font-size:28px;margin:0">Create a discount offer</h1>
  <div style="font-size:13px;color:var(--color-neutral-400)">A published offer works at checkout right away, and can be featured in the promo carousel below the navigator.</div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
    <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-6)">
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <label style="font-size:12px;color:var(--color-neutral-400)">Discount type</label>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-3)">
          ${v.offerTypes.map(t => html`<button data-click="${t.onClick}" style="${t.style}"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${t.label}</div><div style="font-size:11px;color:var(--color-neutral-500)">${t.note}</div></button>`)}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--space-4)">
        <div class="field"><label>${v.valueLabel}</label><input value="${v.g.value}" data-input="${v.setGValue}" type="number" class="input" style="border-color:${v.err.gValueBorder}">${fieldError(v.err.gValue)}</div>
        <div class="field"><label>Code</label><input value="${v.g.code}" data-input="${v.setGCode}" class="input" placeholder="AUTUMN40" style="${MONO};text-transform:uppercase;border-color:${v.err.gCodeBorder}">${fieldError(v.err.gCode)}</div>
        <div class="field"><label>Redemption cap</label><input value="${v.g.cap}" data-input="${v.setGCap}" type="number" class="input"></div>
        <div class="field"><label>Applies to</label><select data-input="${v.setGEvent}" data-value="${v.g.event}" class="input"><option value="all">All my events</option>${v.myEvents.map(e => html`<option value="${e.id}">${e.title}</option>`)}</select></div>
      </div>
      <button data-click="${v.toggleFeatured}" style="${v.featuredStyle}"><span style="${v.featuredBox}">✓</span><div style="text-align:left"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">Feature in the home promo carousel</div><div style="font-size:11.5px;color:var(--color-neutral-500)">Sits below the navigator and scrolls with the page</div></div></button>
      <div style="display:flex;gap:var(--space-3);flex-wrap:wrap"><button data-click="${v.publishOffer}" class="btn btn-primary">Publish offer</button><button data-click="${v.oDash}" class="btn btn-ghost">Cancel</button></div>
    </div>
    <div style="width:330px;flex:none;display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Live preview — carousel slide</h6>
      <div style="padding:var(--space-6);border:1px solid var(--color-accent-800);border-radius:var(--radius-md);background:linear-gradient(120deg, var(--color-accent-900), var(--color-surface));display:flex;flex-direction:column;gap:var(--space-2)">
        <span class="tag tag-accent" style="align-self:flex-start;font-size:10px;letter-spacing:.1em;text-transform:uppercase">Limited offer</span>
        <div style="font-family:var(--font-heading);font-weight:500;font-size:17px">${v.gPreview.title}</div>
        <div style="font-size:12px;color:var(--color-neutral-400)">${v.gPreview.body}</div>
      </div>
      <h6 style="margin:0;color:var(--color-neutral-500)">Live preview — checkout line</h6>
      <div style="padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface);display:flex;flex-direction:column;gap:5px;font-size:12.5px">
        <div style="display:flex;justify-content:space-between;color:var(--color-neutral-400)"><span>2 × general seat</span><span>${v.gPreview.base}</span></div>
        <div style="display:flex;justify-content:space-between;color:var(--color-accent-300)"><span>${v.gPreview.lineLabel}</span><span>${v.gPreview.lineValue}</span></div>
        <div style="display:flex;justify-content:space-between;font-family:var(--font-heading);font-weight:500;font-size:15px"><span>Total</span><span>${v.gPreview.total}</span></div>
      </div>
      <div style="padding:var(--space-4);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Discounts apply to seat prices only — the service fee is never discounted.</div>
    </div>
  </div>
</div>`;
}

function statsView(v) {
  return html`
<div class="pane" data-key="stats" style="display:flex;flex-direction:column;gap:var(--space-8)">
  <h1 style="font-size:28px;margin:0">Analytics</h1>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-6);align-items:stretch">
    <div style="flex:1;min-width:300px;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
      <h4 style="font-size:15px;margin:0">Seats reserved per day</h4>
      <div style="height:170px;display:flex;align-items:flex-end;gap:5px">${v.bars.map(b => html`<div title="${b.title}" style="flex:1;border-radius:2px 2px 0 0;height:${b.h};background:${b.fill}"></div>`)}</div>
      <div style="font-size:11.5px;color:var(--color-neutral-500)">Accent bars used an offer code · today includes your prototype orders</div>
    </div>
    <div style="width:300px;flex:none;display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
      <h4 style="font-size:15px;margin:0">Hold → paid funnel</h4>
      ${v.funnel.map(f => html`
      <div style="display:flex;flex-direction:column;gap:4px"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--color-neutral-400)"><span>${f.label}</span><span>${f.value}</span></div><div style="height:7px;border-radius:2px;background:var(--color-neutral-900);overflow:hidden"><div style="height:100%;background:var(--color-accent);width:${f.pct}"></div></div></div>`)}
      <div style="font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">${v.funnelNote}</div>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:var(--space-4)">
    <h4 style="font-size:16px;margin:0">Offer performance</h4>
    <table class="table" style="width:100%">
      <thead><tr><th>Offer</th><th>Type</th><th>Redeemed</th><th>Discount given</th><th>Net revenue</th></tr></thead>
      <tbody>${v.offerPerf.map(r => html`<tr><td style="${MONO}">${r.code}</td><td>${r.type}</td><td>${r.redeemed}</td><td>${r.given}</td><td>${r.net}</td></tr>`)}</tbody>
    </table>
  </div>
</div>`;
}

function page(v) {
  return html`
<div style="min-height:100vh;background:radial-gradient(120% 80% at 12% -10%, color-mix(in srgb, var(--color-accent) 9%, transparent), transparent 60%), var(--color-bg)">
  ${header(v)}
  <div data-key="main" style="max-width:1120px;margin:0 auto;padding:var(--space-8) var(--space-8) 64px">
    ${v.vBrowse ? browseView(v) : ''}
    ${v.vEvent ? eventView(v) : ''}
    ${v.vSeats ? seatsView(v) : ''}
    ${v.vCheckout ? checkoutView(v) : ''}
    ${v.vConfirm ? confirmView(v) : ''}
    ${v.vMine ? mineView(v) : ''}
    ${v.vAuth ? authView(v) : ''}
    ${v.vODash ? dashView(v) : ''}
    ${v.vOCreate ? createView(v) : ''}
    ${v.vOOffer ? offerView(v) : ''}
    ${v.vOStats ? statsView(v) : ''}
  </div>
  ${v.toast ? html`<div data-key="toast" style="position:fixed;left:50%;bottom:28px;z-index:80;animation:toastIn .2s ease both;display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-6);border:1px solid var(--color-accent-700);border-radius:var(--radius-md);background:var(--color-accent-900);box-shadow:var(--shadow-lg);font-size:13px;color:var(--color-accent-100);max-width:min(420px,88vw)">${v.toast}</div>` : ''}
</div>`;
}

/* ─────────────────────────── render + boot ─────────────────────────── */

const root = document.getElementById('app');
const scratch = document.createElement('template');

function render() {
  renderQueued = false;
  handlers = [];
  scratch.innerHTML = page(viewModel()).s;
  morphChildren(root, scratch.content);
  for (const sel of root.querySelectorAll('select[data-value]')) {
    if (sel.value !== sel.dataset.value) sel.value = sel.dataset.value;
  }
}

root.addEventListener('click', e => {
  const el = e.target.closest('[data-click]');
  if (el && !el.disabled) handlers[el.dataset.click](e);
});
root.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el) handlers[el.dataset.input](e);
});

setInterval(() => setState({ now: Date.now() }), 500);
setInterval(() => {
  if (CONFIG.promoAutoRotate && state.view === 'browse' && state.role === 'attendee') {
    setState(s => ({ promo: (s.promo + 1) % Math.max(1, featured().length) }));
  }
}, 6000);

render();
