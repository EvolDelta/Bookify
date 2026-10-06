/* Bookify — campus ticketing front end.
 * Plain JavaScript talking to the Express API under /api (MySQL behind it):
 * one state object, a render() that rebuilds the page from template strings,
 * and a small DOM patcher so focus, scroll and hover states survive
 * re-renders. No framework, no build step.
 * BRxx numbers refer to the business rules in the Lab 7 proposal. The
 * database enforces them; this page shows them and reports their errors. */
'use strict';

const CONFIG = {
  holdMinutes: 5,        // BR17 — fixed by the database (ck_bookings_lock); used in copy only
  freeWithoutId: 2,      // BR24 — tickets per booking before attendee details are required
  refreshMs: 8000,       // how often an open seat map or hold list re-reads the database
  promoAutoRotate: true  // rotate the promotion carousel every 6s
};

const TYPE_NAMES = ['VIP', 'Priority', 'Normal'];  // Ticket_Type_Catalog (BR14)
const PAY_METHODS = ['PromptPay', 'Bank transfer', 'Cash'];  // BR14
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const baht = n => '฿' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

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

// Only per-browser conveniences live here (which account / organizer you
// last used). Everything that matters lives in MySQL.
const local = {
  get(k) { try { return localStorage.getItem('bookify.' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('bookify.' + k) : localStorage.setItem('bookify.' + k, String(v)); } catch { /* storage blocked */ } }
};

const blankEvent = () => ({
  name: '', venue: '', date: '', time: '19:00', capacity: '120',
  types: {
    VIP:      { on: true,  price: '1200', rows: 'A',    perRow: '10', zone: '',      qty: '' },
    Priority: { on: false, price: '500',  rows: 'B, C', perRow: '10', zone: '',      qty: '' },
    Normal:   { on: true,  price: '300',  rows: '',     perRow: '',   zone: 'Floor', qty: '80' }
  }
});
const blankOffer = () => {
  const end = new Date(); end.setDate(end.getDate() + 30);
  return { type: 'Amount', value: '100', cap: '', code: '', start: ymd(new Date()), end: ymd(end) };
};

const state = {
  role: 'customer', view: 'browse', oview: 'dash', mview: 'sales', aview: 'organizers', rules: false,
  query: '', filter: 'All', promo: 0,
  events: [], promos: [], users: [], organizers: [], allEvents: [],
  eventId: null, event: null,
  selected: [], standing: {}, attendees: {}, attTouched: false, code: '',
  booking: null, deadline: 0, expiring: false, busy: false,
  pay: { method: 'PromptPay', amount: '', status: 'Successful' },
  mine: [], mineTab: 'Pending',
  userId: Number(local.get('user')) || null, organizerId: Number(local.get('organizer')) || null, after: null,
  reg: { full_name: '', email: '', phone_number: '' }, regTouched: false,
  n: blankEvent(), nTouched: false,
  g: blankOffer(), gTouched: false,
  reports: { daily: [], sales: [], seats: [], usage: [], pending: [], fetchedAt: 0 },
  revenueEvent: '', revenue: null,
  orgForm: { organizer_name: '', contact_email: '' }, editUser: null,
  now: Date.now(), toast: ''
};

let renderQueued = false;
function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  if (!renderQueued) { renderQueued = true; queueMicrotask(render); }
}

/* ─────────────────────────── talking to the API ─────────────────────────── */

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}
const get = path => api('GET', path);

let toastTimer;
function say(msg, ms = 3200) {
  setState({ toast: msg });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: '' }), ms);
}
const fail = err => say(err.message, 5200);

const loaders = {
  events: () => get('/events').then(events => setState({ events })),
  allEvents: () => get('/events?status=all').then(allEvents => setState({ allEvents })),
  promos: () => get('/promotions').then(promos => setState({ promos })),
  users: () => get('/users').then(users => setState({ users })),
  organizers: () => get('/organizers').then(organizers => {
    const keep = organizers.some(o => o.organizer_id === state.organizerId);
    const first = organizers.find(o => o.verification_status === 'Verified') || organizers[0];
    setState({ organizers, organizerId: keep ? state.organizerId : first ? first.organizer_id : null });
  }),
  event: () => state.eventId ? get('/events/' + state.eventId).then(dropStaleSelection) : Promise.resolve(),
  mine: () => state.userId ? get(`/users/${state.userId}/bookings`).then(mine => setState({ mine })) : Promise.resolve(),
  booking: () => state.booking ? get('/bookings/' + state.booking.booking_id).then(setBooking) : Promise.resolve(),
  sales: () => get('/reports/sales-last-30-days').then(r => setReports({ daily: r.daily, sales: r.sales })),
  seats: () => get('/reports/seat-status').then(seats => setReports({ seats })),
  usage: () => get('/reports/promotion-usage').then(usage => setReports({ usage })),
  pending: () => get('/reports/pending-bookings').then(pending => setReports({ pending, fetchedAt: Date.now() })),
  revenue: () => state.revenueEvent ? get(`/reports/events/${state.revenueEvent}/revenue`).then(revenue => setState({ revenue })) : Promise.resolve()
};
const setReports = patch => setState({ reports: Object.assign({}, state.reports, patch) });
const load = (...names) => Promise.all(names.map(n => loaders[n]())).catch(fail);

// Which data each screen needs, read fresh every time it opens.
const NEEDS = {
  customer: { browse: ['events', 'promos'], event: ['event'], seats: ['event', 'promos'], checkout: ['booking'], confirm: ['booking'], mine: ['mine'], auth: ['users'] },
  organizer: { dash: ['organizers', 'allEvents', 'promos'], create: ['organizers'], offer: ['promos'] },
  manager: { sales: ['sales', 'allEvents', 'revenue'], seats: ['seats'], usage: ['usage'], holds: ['pending'] },
  admin: { organizers: ['organizers'], users: ['users'], events: ['allEvents'] }
};
const VIEW_KEY = { customer: 'view', organizer: 'oview', manager: 'mview', admin: 'aview' };

function go(role, view) {
  setState({ role, [VIEW_KEY[role]]: view, rules: false, toast: '' });
  window.scrollTo(0, 0);
  load(...NEEDS[role][view]);
}
const switchRole = role => go(role, state[VIEW_KEY[role]]);
const openEvent = id => {
  // A different event starts with an empty selection.
  if (!state.event || state.event.event_id !== id) setState({ event: null, selected: [], standing: {}, attendees: {}, attTouched: false });
  setState({ eventId: id });
  go('customer', 'event');
};

/* ─────────────────────────── domain logic ─────────────────────────── */

const currentUser = () => state.users.find(u => u.user_id === state.userId) || null;
const currentOrganizer = () => state.organizers.find(o => o.organizer_id === state.organizerId) || null;
const unitLabel = u => u.row_label ? u.row_label + u.seat_number : u.zone_name;
const priceOf = (ev, u) => (ev.ticket_types.find(t => t.event_ticket_type_id === u.event_ticket_type_id) || {}).price || 0;
const kindLabel = e => e.seated_units && e.standing_units ? 'Seated + standing' : e.standing_units ? 'Standing' : e.seated_units ? 'Seated' : 'No units yet';

function whenLabel(iso) {
  const d = new Date(iso);
  return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const dayLabel = iso => { const d = new Date(iso); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };
const clock = ms => Math.floor(ms / 60000) + ':' + pad(Math.floor(ms / 1000) % 60);

function promoLabel(p) {
  if (p.discount_type === 'Amount') return baht(p.discount_amount) + ' off';
  return Number(p.discount_percent) + '% off' + (p.max_discount_cap ? ' (up to ' + baht(p.max_discount_cap) + ')' : '');
}

// Standing units of one ticket type in one zone are interchangeable, so they
// are picked by count rather than one by one.
function standingGroups(ev) {
  const groups = new Map();
  for (const u of ev.units) {
    if (u.unit_kind !== 'Standing') continue;
    const key = u.event_ticket_type_id + '|' + u.zone_name;
    if (!groups.has(key)) groups.set(key, { key, zone: u.zone_name, type: u.type_name, price: priceOf(ev, u), units: [] });
    groups.get(key).units.push(u);
  }
  return Array.from(groups.values()).map(g => Object.assign(g, { free: g.units.filter(u => u.unit_status === 'Available') }));
}

// Everything currently picked on the seat map, in booking order.
function chosenUnits() {
  const ev = state.event;
  if (!ev) return [];
  const seats = state.selected.map(id => ev.units.find(u => u.unit_id === id)).filter(Boolean)
    .map(u => ({ unit: u, label: 'Seat ' + unitLabel(u), type: u.type_name, price: priceOf(ev, u) }));
  const standing = standingGroups(ev).flatMap(g => g.free.slice(0, state.standing[g.key] || 0)
    .map(u => ({ unit: u, label: g.zone + ' (standing)', type: g.type, price: g.price, group: g.key })));
  return seats.concat(standing);
}

// After a refresh, drop picks somebody else locked or bought in the meantime.
function dropStaleSelection(ev) {
  const free = id => { const u = ev.units.find(x => x.unit_id === id); return u && u.unit_status === 'Available'; };
  const selected = state.selected.filter(free);
  const standing = {};
  for (const g of standingGroups(ev)) if (state.standing[g.key]) standing[g.key] = Math.min(state.standing[g.key], g.free.length);
  const lost = state.selected.length - selected.length;
  setState({ event: ev, selected, standing });
  if (lost) say(plural(lost, 'seat') + ' you picked just went to someone else.');
}

function toggleSeat(u) {
  if (u.unit_status === 'Sold') return say('That seat is already sold (BR20 — a unit sells once only).');
  if (u.unit_status === 'Locked') return say('Someone is holding that seat for ' + CONFIG.holdMinutes + ' minutes (BR17).');
  const sel = state.selected;
  setState({ selected: sel.includes(u.unit_id) ? sel.filter(id => id !== u.unit_id) : sel.concat([u.unit_id]) });
}
function stepStanding(g, delta) {
  const n = Math.max(0, Math.min(g.free.length, (state.standing[g.key] || 0) + delta));
  if (delta > 0 && n === (state.standing[g.key] || 0)) return say('No more free places in ' + g.zone + '.');
  setState({ standing: Object.assign({}, state.standing, { [g.key]: n }) });
}

function setBooking(b) {
  setState({ booking: b, deadline: Date.now() + (b.seconds_left || 0) * 1000, expiring: false });
}
const paidSoFar = b => b.payments.filter(p => p.payment_status === 'Successful').reduce((t, p) => t + p.amount, 0);
const remainingOf = b => Math.max(0, Math.round((b.total_amount - paidSoFar(b)) * 100) / 100);

async function reserve() {
  const S = state, chosen = chosenUnits();
  if (!S.userId) {
    setState({ after: 'seats' });
    go('customer', 'auth');
    return say('Choose an account first — every booking belongs to one user (BR4).');
  }
  if (!chosen.length) return say('BR9: a booking needs at least one seat or standing place.');
  const units = chosen.map((c, i) => {
    if (i < CONFIG.freeWithoutId) return { unit_id: c.unit.unit_id };
    const a = S.attendees[i] || {};
    return { unit_id: c.unit.unit_id, attendee_name: (a.name || '').trim(), identity_number: (a.idn || '').trim() };
  });
  const extra = units.slice(CONFIG.freeWithoutId);
  if (extra.some(u => !u.attendee_name || !u.identity_number)) {
    setState({ attTouched: true });
    return say('BR24: every ticket after the 2nd needs the attendee’s name and ID number.');
  }
  if (new Set(extra.map(u => u.identity_number)).size !== extra.length) {
    setState({ attTouched: true });
    return say('BR24: each extra ticket must be for a different person.');
  }
  setState({ busy: true });
  try {
    const b = await api('POST', '/bookings', { user_id: S.userId, units, promo_code: S.code.trim() || undefined });
    setBooking(b);
    setState({ selected: [], standing: {}, attendees: {}, attTouched: false, code: '',
      pay: Object.assign({}, S.pay, { amount: String(b.total_amount) }) });
    go('customer', 'checkout');
    load('mine');
    say('Held for ' + CONFIG.holdMinutes + ' minutes (BR17) — pay to make it permanent.');
  } catch (err) {
    fail(err);
    load('event');
  } finally {
    setState({ busy: false });
  }
}

async function payNow() {
  const S = state, b = S.booking, amount = Number(S.pay.amount);
  if (!(amount > 0)) return say('The payment amount must be above zero (BR19).');
  setState({ busy: true });
  try {
    const nb = await api('POST', `/bookings/${b.booking_id}/payments`,
      { payment_method: S.pay.method, amount, payment_status: S.pay.status });
    setBooking(nb);
    load('mine');
    if (nb.booking_status === 'Paid') {
      go('customer', 'confirm');
      say('Paid — ' + plural(nb.items.length, 'ticket') + ' issued (BR12).');
    } else {
      setState({ pay: Object.assign({}, S.pay, { amount: String(remainingOf(nb)) }) });
      say(S.pay.status === 'Successful'
        ? 'Partial payment recorded — ' + baht(remainingOf(nb)) + ' still due before it counts as paid (BR19).'
        : 'Recorded as ' + S.pay.status + ' — only Successful payments count toward the total (BR19).');
    }
  } catch (err) {
    fail(err);
    load('booking');
  } finally {
    setState({ busy: false });
  }
}

async function cancelBooking(id) {
  try {
    const b = await api('POST', `/bookings/${id}/cancel`, { user_id: state.userId });
    if (state.booking && state.booking.booking_id === id) setBooking(b);
    say('Booking #' + id + ' cancelled — its seats are back on sale.');
    load('mine');
  } catch (err) { fail(err); }
}

async function openBooking(id, view) {
  try {
    const b = await get('/bookings/' + id);
    setBooking(b);
    if (b.items.length && (!state.event || state.event.event_id !== b.items[0].event_id)) {
      setState({ eventId: b.items[0].event_id });
      await load('event');
    }
    go('customer', view || (b.booking_status === 'Pending' ? 'checkout' : 'confirm'));
  } catch (err) { fail(err); }
}

function chooseUser(id) {
  local.set('user', id);
  setState({ userId: id, mine: [] });
  const after = state.after;
  setState({ after: null });
  go('customer', after || 'browse');
  load('mine').then(resumePendingHold);
  const u = currentUser();
  say('Booking as ' + (u ? u.full_name : 'user #' + id) + '.');
}
// If this user left a hold running, bring its timer back.
function resumePendingHold() {
  const p = state.mine.find(b => b.booking_status === 'Pending');
  if (p && (!state.booking || state.booking.booking_status !== 'Pending')) get('/bookings/' + p.booking_id).then(setBooking).catch(() => {});
}

function regErrors(r) {
  const e = {};
  if (!r.full_name.trim()) e.full_name = 'We need a name.';
  if (!EMAIL_RE.test(r.email.trim())) e.email = 'That email does not look right.';
  return e;
}
async function register() {
  setState({ regTouched: true });
  if (Object.keys(regErrors(state.reg)).length) return say('Check the highlighted fields.');
  try {
    const u = await api('POST', '/users', state.reg);
    await load('users');
    setState({ reg: { full_name: '', email: '', phone_number: '' }, regTouched: false });
    chooseUser(u.user_id);
  } catch (err) { fail(err); }
}

/* — organizer — */

function eventPlan(n) {
  const types = [], seen = new Set();
  let dupRow = null;
  for (const name of TYPE_NAMES) {
    const t = n.types[name];
    if (!t.on) continue;
    const rows = t.rows.split(/[\s,]+/).map(r => r.trim().toUpperCase()).filter(Boolean);
    rows.forEach(r => { if (seen.has(r)) dupRow = r; seen.add(r); });
    const perRow = Number(t.perRow) || 0, qty = Number(t.qty) || 0, zone = t.zone.trim();
    types.push({ name, price: Number(t.price), rows, perRow, zone, qty, seats: rows.length * perRow, standing: zone ? qty : 0 });
  }
  const seated = types.reduce((s, t) => s + t.seats, 0), standing = types.reduce((s, t) => s + t.standing, 0);
  return { types, seated, standing, total: seated + standing, dupRow };
}

function eventErrors(n) {
  const p = eventPlan(n), e = {}, cap = Number(n.capacity);
  if (!n.name.trim()) e.name = 'Give it a name.';
  if (!n.venue.trim()) e.venue = 'Venue is required.';
  if (!n.date) e.date = 'Pick a date.';
  else if (new Date(n.date + 'T' + (n.time || '00:00')) <= new Date()) e.date = 'BR23: the event date must be in the future.';
  if (!(Number.isInteger(cap) && cap > 0)) e.capacity = 'A whole number above zero.';
  else if (p.total > cap) e.capacity = 'BR22: ' + p.total + ' units but the capacity is ' + cap + '.';
  if (!p.types.length) e.types = 'BR11: offer at least one ticket type.';
  for (const t of p.types) {
    if (e.types) break;
    if (!(t.price > 0)) e.types = 'BR21: ' + t.name + ' needs a price above zero.';
    else if ((t.rows.length > 0) !== (t.perRow > 0)) e.types = t.name + ': give both rows and seats per row.';
    else if ((t.zone !== '') !== (t.qty > 0)) e.types = t.name + ': give both a standing zone and a quantity.';
    else if (!t.seats && !t.standing) e.types = t.name + ' needs seats, a standing zone, or both (BR10).';
  }
  if (!e.types && p.dupRow) e.types = 'BR16: row ' + p.dupRow + ' is used twice — a row and seat must be unique in the event.';
  return e;
}

async function createEvent() {
  const n = state.n, org = currentOrganizer();
  setState({ nTouched: true });
  if (Object.keys(eventErrors(n)).length) return say('Some checks failed — see the form.');
  if (!org) return say('Pick which organizer you are first.');
  const p = eventPlan(n);
  try {
    const r = await api('POST', '/events', {
      organizer_id: org.organizer_id, event_name: n.name.trim(), venue_name: n.venue.trim(),
      event_date: n.date + ' ' + (n.time || '19:00'), total_capacity: Number(n.capacity),
      ticket_types: p.types.map(t => Object.assign({ type_name: t.name, price: t.price },
        t.seats ? { rows: t.rows, seats_per_row: t.perRow } : {},
        t.standing ? { zone_name: t.zone, quantity: t.qty } : {}))
    });
    setState({ n: blankEvent(), nTouched: false });
    go('organizer', 'dash');
    say('Draft created with ' + plural(r.units_created, 'unit') + ' — open it for sale from the dashboard.');
  } catch (err) { fail(err); }
}

async function setEventStatus(id, status) {
  try {
    await api('PATCH', `/events/${id}/status`, { event_status: status });
    say({ On_sale: 'On sale — customers can book it now.', Closed: 'Sales closed.', Cancelled: 'Event cancelled.', Draft: 'Back to draft.' }[status]);
  } catch (err) { fail(err); }
  load('allEvents');
}

function offerErrors(g) {
  const e = {}, code = g.code.trim().toUpperCase(), v = Number(g.value);
  if (!/^[A-Z0-9]{3,30}$/.test(code)) e.code = '3–30 letters or numbers.';
  else if (state.promos.some(p => p.coupon_code === code)) e.code = 'That code already exists.';
  if (!(v > 0)) e.value = 'Must be above zero.';
  else if (g.type === 'Percent' && v > 100) e.value = 'At most 100%.';
  if (g.type === 'Percent' && g.cap !== '' && !(Number(g.cap) > 0)) e.cap = 'Leave empty or above zero.';
  if (!g.start || !g.end) e.end = 'Pick both dates.';
  else if (g.end < g.start) e.end = 'The end date cannot be before the start date.';
  return e;
}

async function publishOffer() {
  const g = state.g;
  setState({ gTouched: true });
  if (Object.keys(offerErrors(g)).length) return say('Fix the promotion fields to publish.');
  const body = { coupon_code: g.code.trim().toUpperCase(), discount_type: g.type, start_date: g.start, end_date: g.end };
  if (g.type === 'Amount') body.discount_amount = Number(g.value);
  else Object.assign(body, { discount_percent: Number(g.value), max_discount_cap: g.cap === '' ? undefined : Number(g.cap) });
  try {
    await api('POST', '/promotions', body);
    setState({ g: blankOffer(), gTouched: false });
    load('promos');
    say(body.coupon_code + ' is live from ' + dayLabel(g.start + 'T00:00') + ' to ' + dayLabel(g.end + 'T00:00') + '.');
  } catch (err) { fail(err); }
}

/* — administrator — */

async function verifyOrganizer(id, status) {
  try {
    await api('PATCH', `/organizers/${id}/verification`, { verification_status: status });
    say(status === 'Verified' ? 'Verified — this organizer can now create events (BR13).' : 'Organizer marked ' + status + '.');
  } catch (err) { fail(err); }
  load('organizers');
}

async function addOrganizer() {
  const f = state.orgForm;
  if (!f.organizer_name.trim() || !EMAIL_RE.test(f.contact_email.trim())) return say('Give a name and a valid contact email.');
  try {
    await api('POST', '/organizers', f);
    setState({ orgForm: { organizer_name: '', contact_email: '' } });
    say('Registered as Pending — verify it before it creates events (BR13).');
  } catch (err) { fail(err); }
  load('organizers');
}

async function saveUser() {
  const u = state.editUser;
  try {
    await api('PATCH', '/users/' + u.user_id, { full_name: u.full_name, email: u.email, phone_number: u.phone_number || null });
    setState({ editUser: null });
    say('User #' + u.user_id + ' updated.');
  } catch (err) { fail(err); }
  load('users');
}

async function removeEvent(id) {
  try {
    await api('DELETE', '/events/' + id);
    say('Event removed.');
  } catch (err) { fail(err); }
  load('allEvents');
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
    wait: 'var(--color-accent-2-800);color:var(--color-accent-2-100)',
    quiet: 'var(--color-neutral-900);color:var(--color-neutral-400)'
  };
  return 'padding:3px 9px;border-radius:999px;font-size:10.5px;font-family:var(--font-heading);font-weight:500;white-space:nowrap;background:' + (map[kind] || map.quiet);
}
// Every status value in the schema (BR14) gets one of three looks.
const STATUS_KIND = {
  Paid: 'ok', Sold: 'ok', Successful: 'ok', Verified: 'ok', On_sale: 'ok', Available: 'ok',
  Pending: 'wait', Locked: 'wait', Draft: 'wait'
};
const statusPill = s => html`<span style="${pill(STATUS_KIND[s] || 'quiet')}">${String(s).replace('_', ' ')}</span>`;
function card(active) {
  return 'text-align:left;cursor:pointer;padding:var(--space-4) var(--space-6);border-radius:var(--radius-md);display:flex;flex-direction:column;gap:3px;' +
    (active ? 'border:1px solid var(--color-accent);background:color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'border:1px solid var(--color-neutral-800);background:var(--color-surface)');
}
const bd = err => err ? 'var(--color-accent-500)' : 'var(--color-neutral-800)';
const PANEL = 'display:flex;flex-direction:column;gap:var(--space-4);padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-md)';
const BOX = 'padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)';
const EMPTY = 'padding:var(--space-8);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);text-align:center;font-size:13px;color:var(--color-neutral-500)';
const NOTE = 'padding:var(--space-4);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)';
const MONO = 'font-family:ui-monospace,Menlo,monospace';

// Update one field of a nested form object in state.
const set = (key, field, transform = v => v) => e => setState({ [key]: Object.assign({}, state[key], { [field]: transform(e.target.value) }) });

/* ───────────────────────────── markup ───────────────────────────── */

const fieldError = msg => msg ? html`<div style="font-size:11.5px;color:var(--color-accent-300);margin-top:4px">${msg}</div>` : '';
const field = (label, value, onInput, o = {}) => html`
<div class="field"><label>${label}</label><input value="${value}" data-input="${onInput}" class="input" type="${o.type || 'text'}" placeholder="${o.placeholder || ''}" ${o.min ? html`min="${o.min}"` : ''} style="border-color:${bd(o.error)};${o.style || ''}">${fieldError(o.error)}</div>`;
const h1 = (title, sub) => html`<div style="display:flex;flex-direction:column;gap:4px"><h1 style="font-size:28px;margin:0">${title}</h1>${sub ? html`<div style="font-size:13px;color:var(--color-neutral-400)">${sub}</div>` : ''}</div>`;
const kpi = (label, value, note) => html`
<div style="${BOX};display:flex;flex-direction:column;gap:5px"><h6 style="margin:0;color:var(--color-neutral-500)">${label}</h6><div style="font-family:var(--font-heading);font-weight:500;font-size:26px">${value}</div><div style="font-size:11.5px;color:var(--color-accent-300)">${note}</div></div>`;
const bar = (pct, fill = 'var(--color-accent)') => html`<div style="height:5px;border-radius:3px;background:var(--color-neutral-900);overflow:hidden"><div style="height:100%;background:${fill};width:${pct}%"></div></div>`;
const ruleTag = id => html`<span class="tag tag-outline" style="font-size:10px;padding:1px 7px">${id}</span>`;

function header() {
  const S = state, user = currentUser();
  const roleTag = { customer: 'Attend', organizer: 'Host', manager: 'Manage', admin: 'Admin' }[S.role];
  const pending = S.mine.filter(b => b.booking_status === 'Pending').length;
  const nav = (role, items) => html`
  <div style="flex:1;display:flex;align-items:center;gap:var(--space-2);min-width:0;overflow:auto">
    ${items.map(([key, label]) => html`<button data-click="${() => go(role, key)}" style="${navBtn(!S.rules && S[VIEW_KEY[role]] === key)}">${label}</button>`)}
  </div>`;
  const hold = S.role === 'customer' && S.booking && S.booking.booking_status === 'Pending';
  const left = Math.max(0, S.deadline - S.now);
  return html`
<div data-key="nav" style="position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:var(--space-6);padding:var(--space-4) var(--space-8);background:color-mix(in srgb, var(--color-bg) 88%, transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--color-divider)">
  <button data-click="${() => go('customer', 'browse')}" style="display:flex;align-items:baseline;gap:6px;border:0;background:none;cursor:pointer;padding:0;font-family:var(--font-heading);font-weight:500;font-size:17px;letter-spacing:-.02em;color:var(--color-text)">Bookify<span style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-accent)">${roleTag}</span></button>
  ${S.role === 'customer' ? html`
  <div style="flex:1;display:flex;align-items:center;gap:var(--space-4);min-width:0">
    <input value="${S.query}" data-input="${e => { setState({ query: e.target.value }); if (S.view !== 'browse' || S.rules) go('customer', 'browse'); }}" placeholder="Search events, venues, organizers" class="input" style="flex:1;min-width:0;max-width:420px;font-size:13px">
    <button data-click="${() => go('customer', 'browse')}" class="btn btn-ghost" style="font-size:13px">Browse</button>
    <button data-click="${() => go('customer', 'mine')}" class="btn btn-ghost" style="font-size:13px">Reservations ${pending ? html`<span class="tag tag-accent" style="margin-left:5px;font-size:10px">${pending}</span>` : ''}</button>
  </div>` : ''}
  ${S.role === 'organizer' ? nav('organizer', [['dash', 'Dashboard'], ['create', 'Create event'], ['offer', 'Promotions']]) : ''}
  ${S.role === 'manager' ? nav('manager', [['sales', 'Sales'], ['seats', 'Seat status'], ['usage', 'Promotion usage'], ['holds', 'Holds']]) : ''}
  ${S.role === 'admin' ? nav('admin', [['organizers', 'Organizers'], ['users', 'Users'], ['events', 'Events']]) : ''}
  <div style="display:flex;align-items:center;gap:var(--space-3)">
    <button data-click="${() => { setState({ rules: true }); window.scrollTo(0, 0); }}" style="${navBtn(S.rules)}">Rules</button>
    <div class="seg" style="font-size:12px">
      ${[['customer', 'Attend'], ['organizer', 'Host'], ['manager', 'Manage'], ['admin', 'Admin']].map(([r, label]) =>
        html`<button data-click="${() => switchRole(r)}" style="${seg(S.role === r)}">${label}</button>`)}
    </div>
    ${S.role === 'customer' && user ? html`<div style="display:flex;align-items:center;gap:7px" title="${user.full_name} · ${user.email}"><div style="width:26px;height:26px;border-radius:50%;background:var(--color-accent-800);color:var(--color-accent-200);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:500">${user.full_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}</div><button data-click="${() => go('customer', 'auth')}" class="btn btn-ghost" style="font-size:12px">Switch</button></div>` : ''}
    ${S.role === 'customer' && !user ? html`<button data-click="${() => go('customer', 'auth')}" class="btn btn-primary" style="font-size:13px">Sign in</button>` : ''}
  </div>
</div>
${hold ? html`
<div data-key="hold" style="position:sticky;top:57px;z-index:35;display:flex;align-items:center;gap:var(--space-4);padding:var(--space-3) var(--space-8);background:var(--color-accent-900);border-bottom:1px solid var(--color-accent-700)">
  <div style="font-family:var(--font-heading);font-weight:500;font-size:14px;color:var(--color-accent-200);font-variant-numeric:tabular-nums">${clock(left)}</div>
  <div style="flex:1;font-size:12.5px;color:var(--color-accent-300)">Booking #${S.booking.booking_id} · ${plural(S.booking.items.length, 'unit')} locked to you — pay ${baht(remainingOf(S.booking))} before the timer ends or they go back on sale (BR17, BR18).</div>
  <div style="width:180px;height:3px;border-radius:2px;background:var(--color-accent-800);overflow:hidden"><div style="height:100%;background:var(--color-accent);width:${Math.round(left / (CONFIG.holdMinutes * 600))}%"></div></div>
  ${S.view !== 'checkout' || S.rules ? html`<button data-click="${() => openBooking(S.booking.booking_id, 'checkout')}" class="btn btn-ghost" style="font-size:12px;color:var(--color-accent-200)">Pay now</button>` : ''}
  <button data-click="${() => cancelBooking(S.booking.booking_id)}" class="btn btn-ghost" style="font-size:12px;color:var(--color-accent-300)">Release</button>
</div>` : ''}`;
}

/* — customer — */

function browseView() {
  const S = state, q = S.query.trim().toLowerCase();
  const FILTERS = {
    'All': () => true,
    'Seated': e => e.seated_units > 0 && !e.standing_units,
    'Standing': e => e.standing_units > 0 && !e.seated_units,
    'Seated + standing': e => e.seated_units > 0 && e.standing_units > 0,
    'Has space': e => !e.is_full
  };
  const list = S.events.filter(e => (!q || (e.event_name + ' ' + e.venue_name + ' ' + e.organizer_name).toLowerCase().includes(q)) && FILTERS[S.filter](e));
  const live = S.promos.filter(p => p.active_today);
  const pi = Math.min(S.promo, Math.max(0, live.length - 1)), po = live[pi];
  const step = d => () => setState({ promo: (pi + d + live.length) % Math.max(1, live.length) });
  return html`
<div class="pane" data-key="browse" style="display:flex;flex-direction:column;gap:var(--space-8)">
  <div style="display:flex;align-items:stretch;gap:var(--space-4)">
    <button data-click="${step(-1)}" class="btn btn-icon lift" style="align-self:center;border:1px solid var(--color-neutral-800)">‹</button>
    <div style="flex:1;min-width:0;display:flex;gap:var(--space-8);align-items:center;padding:var(--space-8);border:1px solid var(--color-accent-800);border-radius:var(--radius-lg);background:linear-gradient(100deg, var(--color-accent-900), var(--color-surface) 70%)">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--space-3)">
        ${po ? html`
        <div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap"><span class="tag tag-accent" style="font-size:10px;letter-spacing:.1em;text-transform:uppercase">${po.discount_type} discount</span><span style="font-size:11.5px;color:var(--color-neutral-500)">valid ${dayLabel(po.start_date)} – ${dayLabel(po.end_date)} · used ${plural(po.times_used, 'time')}</span></div>
        <h2 style="font-size:28px;margin:0">${promoLabel(po)} with ${po.coupon_code}</h2>
        <div style="font-size:13.5px;color:var(--color-neutral-400);max-width:52ch">Works on any event while it is valid. One promotion per booking (BR8), and only inside its dates (BR22).</div>
        <div style="display:flex;align-items:center;gap:var(--space-4);margin-top:var(--space-2)">
          <button data-click="${() => { setState({ code: po.coupon_code }); say(po.coupon_code + ' will be used on your next booking.'); }}" class="btn btn-secondary" style="${MONO};font-size:13px">${po.coupon_code} · use it</button>
        </div>` : html`
        <h2 style="font-size:28px;margin:0">No promotions running today</h2>
        <div style="font-size:13.5px;color:var(--color-neutral-400)">Organizers publish them from the Host side.</div>`}
      </div>
      <div style="width:220px;height:130px;flex:none;border-radius:var(--radius-md);border:1px solid var(--color-neutral-800);background:linear-gradient(140deg, var(--color-section), var(--color-neutral-900));display:flex;align-items:flex-end;padding:var(--space-4);font-size:11px;color:var(--color-neutral-500)">${live.length ? (pi + 1) + ' of ' + live.length + ' promotions' : 'promotions'}</div>
    </div>
    <button data-click="${step(1)}" class="btn btn-icon lift" style="align-self:center;border:1px solid var(--color-neutral-800)">›</button>
  </div>
  <div style="display:flex;gap:6px;justify-content:center;margin-top:calc(-1 * var(--space-6))">
    ${live.map((p, i) => html`<button data-click="${() => setState({ promo: i })}" style="width:${i === pi ? '18px' : '6px'};height:4px;border:0;border-radius:2px;padding:0;cursor:pointer;background:${i === pi ? 'var(--color-accent)' : 'var(--color-neutral-800)'}"></button>`)}
  </div>

  <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center">
    ${Object.keys(FILTERS).map(f => html`<button data-click="${() => setState({ filter: f })}" style="${chip(S.filter === f)}">${f}</button>`)}
    <div style="margin-left:auto;font-size:12px;color:var(--color-neutral-500)">${list.length} of ${plural(S.events.length, 'event')} on sale</div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:var(--space-6)">
    ${list.map(e => html`
    <button data-click="${() => openEvent(e.event_id)}" class="card lift" style="text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:var(--space-3);padding:0;overflow:hidden;border:1px solid var(--color-neutral-800)">
      <div style="height:120px;background:linear-gradient(135deg, var(--color-neutral-900), var(--color-section-ghost));display:flex;align-items:flex-end;justify-content:space-between;padding:var(--space-3) var(--space-4);gap:8px">
        <span style="font-size:10.5px;color:var(--color-neutral-400)">${kindLabel(e)}</span>
        ${e.is_full ? html`<span class="tag tag-neutral" style="font-size:10px">Sold out</span>` : ''}
      </div>
      <div style="padding:0 var(--space-6) var(--space-6);display:flex;flex-direction:column;gap:var(--space-2)">
        <div class="card-kicker" style="font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500)">${whenLabel(e.event_date)}</div>
        <div class="card-title" style="font-family:var(--font-heading);font-weight:500;font-size:16px">${e.event_name}</div>
        <div style="font-size:12.5px;color:var(--color-neutral-400)">${e.venue_name} · ${e.organizer_name}</div>
        <div style="display:flex;align-items:baseline;gap:var(--space-3);margin-top:var(--space-2)">
          <div style="font-family:var(--font-heading);font-weight:500;font-size:15px">from ${baht(e.price_from)}</div>
          <div style="font-size:11.5px;color:var(--color-neutral-500)">${e.available} of ${e.units} left</div>
          <div style="margin-left:auto;font-size:12px;color:var(--color-accent)">Reserve →</div>
        </div>
      </div>
    </button>`)}
  </div>
  ${!list.length ? html`<div style="${EMPTY}">Nothing matches that search. <button data-click="${() => setState({ query: '', filter: 'All' })}" class="btn btn-ghost" style="font-size:13px">Clear filters</button></div>` : ''}
</div>`;
}

function eventView() {
  const ev = state.event;
  if (!ev) return html`<div class="pane" data-key="event" style="${EMPTY}">Loading event…</div>`;
  const zones = standingGroups(ev);
  const onSale = ev.event_status === 'On_sale', full = ev.units > 0 && ev.sold === ev.units;
  return html`
<div class="pane" data-key="event" style="display:flex;flex-direction:column;gap:var(--space-6)">
  <button data-click="${() => go('customer', 'browse')}" class="btn btn-ghost" style="align-self:flex-start;font-size:12.5px">← All events</button>
  <div style="height:220px;border-radius:var(--radius-lg);border:1px solid var(--color-neutral-800);background:linear-gradient(120deg, var(--color-section), var(--color-neutral-900) 70%);display:flex;align-items:flex-end;padding:var(--space-6);font-size:11px;color:var(--color-neutral-500)">${ev.venue_name}</div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
    <div style="flex:1;min-width:300px;display:flex;flex-direction:column;gap:var(--space-6)">
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center">${statusPill(ev.event_status)}<span class="tag tag-outline" style="font-size:11px">${kindLabel(ev)}</span>${full ? html`<span class="tag tag-neutral" style="font-size:11px">Sold out</span>` : ''}</div>
        <h1 style="font-size:34px;margin:0">${ev.event_name}</h1>
        <div style="font-size:13.5px;color:var(--color-neutral-400)">${whenLabel(ev.event_date)} · ${ev.venue_name}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <h4 style="font-size:15px;margin:0">Ticket types</h4>
        ${ev.ticket_types.map(t => html`
        <div style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-4) var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
          <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:14px">${t.type_name}</div><div style="font-size:12px;color:var(--color-neutral-500)">${t.description || ''} · ${t.available} of ${t.units} available</div></div>
          <div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${baht(t.price)}</div>
        </div>`)}
        ${!ev.ticket_types.length ? html`<div style="${EMPTY}">No ticket types yet (BR11).</div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <h4 style="font-size:15px;margin:0">Where you can be</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-3)">
          ${ev.seated_units ? html`<div style="${BOX}"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">Numbered seats</div><div style="font-size:12px;color:var(--color-neutral-500)">${ev.seated_units} seats · pick your own row and seat</div></div>` : ''}
          ${zones.map(g => html`<div style="${BOX}"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${g.zone}</div><div style="font-size:12px;color:var(--color-neutral-500)">Standing · ${g.type} · ${g.free.length} of ${g.units.length} free</div></div>`)}
        </div>
      </div>
      <div style="display:flex;gap:var(--space-4);align-items:center;padding:var(--space-4) var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md)">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--color-neutral-900);border:1px solid var(--color-neutral-800)"></div>
        <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${ev.organizer_name}</div><div style="font-size:12px;color:var(--color-neutral-500)">Verified organizer (BR13)</div></div>
      </div>
    </div>
    <div style="width:320px;flex:none;position:sticky;top:90px;${PANEL}">
      <div style="display:flex;align-items:baseline;gap:var(--space-3)"><div style="font-family:var(--font-heading);font-weight:500;font-size:26px">from ${baht(ev.price_from)}</div><div style="font-size:12px;color:var(--color-neutral-500)">per ticket</div></div>
      <div style="height:1px;background:var(--color-divider)"></div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--color-neutral-400)">
        <div>${ev.available} available · ${ev.locked} on hold · ${ev.sold} sold</div>
        <div>Capacity ${ev.total_capacity}</div>
        <div>Up to ${CONFIG.freeWithoutId} tickets per booking without ID; more need each attendee’s ID (BR24)</div>
      </div>
      <button data-click="${() => go('customer', 'seats')}" ${!onSale || full ? html`disabled` : ''} class="btn btn-primary btn-block">${!onSale ? 'Not on sale' : full ? 'Sold out' : 'Choose seats'}</button>
      <div style="font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Reserving locks your picks for ${CONFIG.holdMinutes} minutes while you pay. Unpaid holds return to sale automatically (BR17, BR18).</div>
    </div>
  </div>
</div>`;
}

function seatsView() {
  const S = state, ev = S.event;
  if (!ev) return html`<div class="pane" data-key="seats" style="${EMPTY}">Loading seat map…</div>`;
  const rows = [];
  for (const u of ev.units) {
    if (u.unit_kind !== 'Seated') continue;
    let r = rows[rows.length - 1];
    if (!r || r.label !== u.row_label) rows.push(r = { label: u.row_label, seats: [] });
    r.seats.push(u);
  }
  const zones = standingGroups(ev), chosen = chosenUnits();
  const subtotal = chosen.reduce((t, c) => t + c.price, 0);
  const legend = (style, label) => html`<div style="display:flex;align-items:center;gap:5px"><span style="width:11px;height:11px;border-radius:3px;${style}"></span>${label}</div>`;
  const att = i => S.attendees[i] || { name: '', idn: '' };
  const setAtt = (i, k) => e => setState({ attendees: Object.assign({}, S.attendees, { [i]: Object.assign({}, att(i), { [k]: e.target.value }) }) });
  return html`
<div class="pane" data-key="seats" style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
  <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-6)">
    <div style="display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap">
      <button data-click="${() => go('customer', 'event')}" class="btn btn-ghost" style="font-size:12.5px">← ${ev.event_name}</button>
      <div style="margin-left:auto;display:flex;gap:var(--space-4);flex-wrap:wrap;font-size:11.5px;color:var(--color-neutral-400)">
        ${legend('border:1px solid var(--color-neutral-600)', 'Available')}
        ${legend('background:var(--color-accent)', 'Yours')}
        ${legend('background:var(--color-accent-800)', 'Locked')}
        ${legend('background:var(--color-neutral-800)', 'Sold')}
      </div>
    </div>
    ${rows.length ? html`
    <div style="display:flex;flex-direction:column;align-items:center;gap:var(--space-6);padding:var(--space-8) var(--space-4);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);overflow:auto">
      <div style="width:min(420px,90%);height:26px;border-radius:200px 200px 0 0;border:1px solid var(--color-neutral-700);background:linear-gradient(var(--color-neutral-900),transparent);display:flex;align-items:center;justify-content:center;font-size:10.5px;letter-spacing:.2em;color:var(--color-neutral-400)">STAGE</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${rows.map(row => html`
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:16px;font-size:10px;color:var(--color-neutral-600)">${row.label}</div>
          ${row.seats.map(u => {
            const mine = S.selected.includes(u.unit_id), st = u.unit_status;
            const fill = mine ? 'var(--color-accent)' : st === 'Sold' ? 'var(--color-neutral-800)' : st === 'Locked' ? 'var(--color-accent-800)' : 'transparent';
            const border = mine ? 'var(--color-accent)' : st === 'Sold' ? 'var(--color-neutral-800)' : st === 'Locked' ? 'var(--color-accent-700)' : 'var(--color-neutral-600)';
            return html`<button data-click="${() => toggleSeat(u)}" title="${unitLabel(u)} · ${u.type_name} · ${baht(priceOf(ev, u))} · ${st}" class="seat" style="width:18px;height:16px;border-radius:3px;padding:0;cursor:${st === 'Available' ? 'pointer' : 'not-allowed'};background:${fill};border:1px solid ${border}"></button>`;
          })}
          <div style="width:16px;font-size:10px;color:var(--color-neutral-600)">${row.seats[0].type_name[0]}</div>
        </div>`)}
      </div>
      <div style="font-size:11.5px;color:var(--color-neutral-500)">Letter on the right = ticket type (V = VIP, P = Priority, N = Normal) · tap a seat to add or drop it</div>
    </div>` : ''}
    ${zones.length ? html`
    <div style="display:flex;flex-direction:column;gap:var(--space-3)">
      <h4 style="font-size:15px;margin:0">Standing zones</h4>
      ${zones.map(g => html`
      <div style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-4) var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface)">
        <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:14px">${g.zone}</div><div style="font-size:12px;color:var(--color-neutral-500)">${g.type} · ${baht(g.price)} · ${g.free.length} of ${g.units.length} free · no seat number (BR16)</div></div>
        <div class="seg"><button data-click="${() => stepStanding(g, -1)}" style="${seg(false)}">−</button><span style="padding:5px 12px;font-size:13px;font-variant-numeric:tabular-nums">${S.standing[g.key] || 0}</span><button data-click="${() => stepStanding(g, 1)}" style="${seg(false)}">+</button></div>
      </div>`)}
    </div>` : ''}
  </div>
  <div style="width:340px;flex:none;${PANEL}">
    <h4 style="font-size:15px;margin:0">Your selection</h4>
    ${!chosen.length ? html`<div style="padding:var(--space-6);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-md);font-size:12.5px;color:var(--color-neutral-500);text-align:center">Pick seats or standing places. Nothing is held until you reserve.</div>` : ''}
    ${chosen.map((c, i) => html`
    <div style="display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3) var(--space-4);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md)">
      <div style="display:flex;align-items:center;gap:var(--space-3)">
        <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${c.label}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">Ticket ${i + 1} · ${c.type}</div></div>
        <div style="font-size:13.5px">${baht(c.price)}</div>
        <button data-click="${() => c.group ? stepStanding(zones.find(g => g.key === c.group), -1) : toggleSeat(c.unit)}" class="btn btn-ghost" style="font-size:12px;padding:2px 6px;color:var(--color-neutral-500)">✕</button>
      </div>
      ${i >= CONFIG.freeWithoutId ? html`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2)">
        <input value="${att(i).name}" data-input="${setAtt(i, 'name')}" class="input" placeholder="Attendee name" style="font-size:12.5px;border-color:${bd(S.attTouched && !att(i).name.trim())}">
        <input value="${att(i).idn}" data-input="${setAtt(i, 'idn')}" class="input" placeholder="ID number" style="font-size:12.5px;${MONO};border-color:${bd(S.attTouched && !att(i).idn.trim())}">
      </div>` : ''}
    </div>`)}
    ${chosen.length > CONFIG.freeWithoutId ? html`<div style="font-size:11.5px;color:var(--color-accent-300)">BR24: tickets after the 2nd need the attendee’s name and ID number, and an ID can hold one ticket per event.</div>` : ''}
    <div style="display:flex;gap:var(--space-3)"><input value="${S.code}" data-input="${e => setState({ code: e.target.value.toUpperCase() })}" class="input" placeholder="Promotion code (optional)" style="flex:1;${MONO};text-transform:uppercase"></div>
    <div style="font-size:11.5px;color:var(--color-neutral-600)">Valid today: ${S.promos.filter(p => p.active_today).map(p => p.coupon_code).join(' · ') || 'none'}</div>
    <div style="height:1px;background:var(--color-divider)"></div>
    <div style="display:flex;justify-content:space-between;font-family:var(--font-heading);font-weight:500;font-size:16px"><span>Subtotal</span><span>${baht(subtotal)}</span></div>
    <div style="font-size:11.5px;color:var(--color-neutral-500)">The database works out the discount and fixes every price when you reserve (BR21).</div>
    <button data-click="${reserve}" ${!chosen.length || S.busy ? html`disabled` : ''} class="btn btn-primary btn-block">${S.busy ? 'Reserving…' : 'Reserve & hold ' + CONFIG.holdMinutes + ' min'}</button>
  </div>
</div>`;
}

function itemRows(b) {
  return b.items.map(it => html`
  <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md)">
    <div style="flex:1;min-width:0"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${it.unit_kind === 'Seated' ? 'Seat ' + it.row_label + it.seat_number : it.zone_name + ' (standing)'}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">${it.type_name}${it.attendee_name ? ' · ' + it.attendee_name : ''}</div></div>
    ${it.ticket_code ? html`<span style="${MONO};font-size:12px;color:var(--color-accent-300)">${it.ticket_code}</span>` : ''}
    <div style="font-size:13.5px">${baht(it.price_paid)}</div>
  </div>`);
}

function totals(b, size) {
  const sub = b.items.reduce((t, it) => t + it.price_paid, 0), paid = paidSoFar(b);
  const line = (l, r, c) => html`<div style="display:flex;justify-content:space-between;color:${c || 'var(--color-neutral-400)'}"><span>${l}</span><span>${r}</span></div>`;
  return html`
<div style="display:flex;flex-direction:column;gap:5px;font-size:12.5px">
  ${line(plural(b.items.length, 'ticket'), baht(sub))}
  ${b.discount_amount_applied > 0 ? line((b.coupon_code || 'Promotion') + ' (BR8)', '−' + baht(b.discount_amount_applied), 'var(--color-accent-300)') : ''}
  <div style="display:flex;justify-content:space-between;padding-top:var(--space-3);margin-top:var(--space-2);border-top:1px solid var(--color-divider);font-family:var(--font-heading);font-weight:500;font-size:${size}"><span>Total</span><span>${baht(b.total_amount)}</span></div>
  ${paid > 0 ? line('Paid so far', baht(paid)) : ''}
  ${b.booking_status === 'Pending' && paid > 0 ? line('Still due', baht(remainingOf(b)), 'var(--color-accent-300)') : ''}
</div>`;
}

function checkoutView() {
  const S = state, b = S.booking, ev = S.event;
  if (!b) return html`<div class="pane" data-key="checkout" style="${EMPTY}">No booking open. <button data-click="${() => go('customer', 'mine')}" class="btn btn-ghost" style="font-size:13px">My reservations</button></div>`;
  const pending = b.booking_status === 'Pending';
  return html`
<div class="pane" data-key="checkout" style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
  <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-6)">
    <div style="display:flex;align-items:center;gap:var(--space-3)"><h1 style="font-size:28px;margin:0">Checkout</h1>${statusPill(b.booking_status)}</div>
    ${!pending ? html`<div style="${NOTE}">Booking #${b.booking_id} is ${b.booking_status}. ${b.booking_status === 'Expired' ? 'The ' + CONFIG.holdMinutes + '-minute hold ran out before it was paid, so its units went back on sale (BR18).' : ''}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:var(--space-3)">
      <h6 style="margin:0;color:var(--color-neutral-500)">1 · Your tickets — booking #${b.booking_id}</h6>
      ${itemRows(b)}
    </div>
    ${pending ? html`
    <div style="display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">2 · Payment</h6>
      <div class="seg" style="align-self:flex-start">${PAY_METHODS.map(m => html`<button data-click="${() => setState({ pay: Object.assign({}, S.pay, { method: m }) })}" style="${seg(S.pay.method === m)}">${m}</button>`)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-4)">
        ${field('Amount (฿)', S.pay.amount, set('pay', 'amount'), { type: 'number' })}
        <div class="field"><label>Result (sample data — no real gateway)</label><div class="seg">${['Successful', 'Failed', 'Pending'].map(st => html`<button data-click="${() => setState({ pay: Object.assign({}, S.pay, { status: st }) })}" style="${seg(S.pay.status === st)}">${st}</button>`)}</div></div>
      </div>
      <div style="font-size:11.5px;color:var(--color-neutral-500)">BR19: the booking is Paid once its Successful payments add up to the total. You can split it across several payments.</div>
    </div>` : ''}
    ${b.payments.length ? html`
    <div style="display:flex;flex-direction:column;gap:var(--space-3)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Payments on this booking (BR6)</h6>
      <table class="table"><thead><tr><th>#</th><th>Method</th><th>Amount</th><th>When</th><th>Status</th></tr></thead>
      <tbody>${b.payments.map(p => html`<tr><td>${p.payment_id}</td><td>${p.payment_method}</td><td>${baht(p.amount)}</td><td>${whenLabel(p.paid_at)}</td><td>${statusPill(p.payment_status)}</td></tr>`)}</tbody></table>
    </div>` : ''}
  </div>
  <div style="width:330px;flex:none;position:sticky;top:110px;${PANEL}">
    <div style="display:flex;flex-direction:column;gap:4px"><div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${b.items[0] ? b.items[0].event_name : ''}</div><div style="font-size:12px;color:var(--color-neutral-500)">${b.items[0] ? whenLabel(b.items[0].event_date) : ''}${ev ? ' · ' + ev.venue_name : ''}</div></div>
    <div style="height:1px;background:var(--color-divider)"></div>
    ${totals(b, '18px')}
    ${pending ? html`<button data-click="${payNow}" ${S.busy ? html`disabled` : ''} class="btn btn-primary btn-block">${S.busy ? 'Recording…' : 'Pay ' + baht(Number(S.pay.amount) || 0) + ' · ' + S.pay.method}</button>
    <div style="font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Payment turns the ${CONFIG.holdMinutes}-minute hold into Sold units and issues one ticket per unit (BR7, BR18).</div>
    <button data-click="${() => cancelBooking(b.booking_id)}" class="btn btn-ghost" style="font-size:12px;align-self:flex-start">Cancel this booking</button>` : html`
    <button data-click="${() => go('customer', 'mine')}" class="btn btn-secondary btn-block">My reservations</button>`}
  </div>
</div>`;
}

function confirmView() {
  const S = state, b = S.booking, ev = S.event;
  if (!b) return html`<div class="pane" data-key="confirm" style="${EMPTY}">No booking open.</div>`;
  if (b.booking_status !== 'Paid') return checkoutView();
  const first = b.items[0] || {};
  const cell = (label, value) => html`<div><div style="font-size:11px;color:var(--color-neutral-500)">${label}</div><div>${value}</div></div>`;
  return html`
<div class="pane" data-key="confirm" style="display:flex;flex-direction:column;align-items:center;gap:var(--space-8);padding-top:var(--space-8)">
  <div style="display:flex;flex-direction:column;align-items:center;gap:var(--space-3);text-align:center">
    <div style="width:44px;height:44px;border-radius:50%;border:1px solid var(--color-accent);color:var(--color-accent);display:flex;align-items:center;justify-content:center;font-size:19px">✓</div>
    <h1 style="font-size:28px;margin:0">Paid — ${plural(b.items.length, 'ticket')} ${b.items.length > 1 ? 'are' : 'is'} yours</h1>
    <div style="font-size:13.5px;color:var(--color-neutral-400);max-width:56ch">The hold is gone and every unit is Sold for good. Each one got exactly one ticket code (BR7, BR12, BR20).</div>
  </div>
  <div style="display:flex;flex-wrap:wrap;width:min(700px,100%);border:1px solid var(--color-neutral-800);border-radius:var(--radius-lg);background:var(--color-surface);overflow:hidden;box-shadow:var(--shadow-md)">
    <div style="flex:1;min-width:260px;padding:var(--space-8);display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Booking #${b.booking_id}</h6>
      <div style="font-family:var(--font-heading);font-weight:500;font-size:19px">${first.event_name}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-4);font-size:13px">
        ${cell('When', first.event_date ? whenLabel(first.event_date) : '')}${cell('Venue', ev ? ev.venue_name : '')}
        ${cell('Total paid', baht(b.total_amount))}${cell('Promotion', b.coupon_code || '—')}
      </div>
    </div>
    <div style="width:280px;flex:none;padding:var(--space-8);display:flex;flex-direction:column;gap:var(--space-3);border-left:1px solid var(--color-divider)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Tickets</h6>
      ${b.items.map(it => html`<div style="display:flex;justify-content:space-between;gap:var(--space-3);font-size:12.5px"><span>${it.unit_kind === 'Seated' ? 'Seat ' + it.row_label + it.seat_number : it.zone_name}</span><span style="${MONO};color:var(--color-accent-300)">${it.ticket_code}</span></div>`)}
    </div>
  </div>
  <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;justify-content:center"><button data-click="${() => go('customer', 'mine')}" class="btn btn-primary">View my reservations</button><button data-click="${() => go('customer', 'browse')}" class="btn btn-secondary">Keep browsing</button></div>
</div>`;
}

function mineView() {
  const S = state;
  if (!S.userId) return html`<div class="pane" data-key="mine" style="${EMPTY}">Choose an account to see its reservations. <button data-click="${() => go('customer', 'auth')}" class="btn btn-ghost" style="font-size:13px">Sign in</button></div>`;
  const tabs = ['Pending', 'Paid', 'Expired', 'Cancelled'];
  const list = S.mine.filter(b => b.booking_status === S.mineTab);
  const user = currentUser();
  return html`
<div class="pane" data-key="mine" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('My reservations', user ? user.full_name + ' · ' + user.email + ' — every booking belongs to exactly one user (BR4)' : '')}
  <div style="display:flex;gap:var(--space-2);flex-wrap:wrap">${tabs.map(t => html`<button data-click="${() => setState({ mineTab: t })}" style="${chip(S.mineTab === t)}">${t} · ${S.mine.filter(b => b.booking_status === t).length}</button>`)}</div>
  ${!list.length ? html`<div style="${EMPTY}">Nothing here. <button data-click="${() => go('customer', 'browse')}" class="btn btn-ghost" style="font-size:13px">Find an event</button></div>` : ''}
  ${list.map(b => html`
  <div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-4);${BOX}">
    <div style="width:72px;height:56px;flex:none;border-radius:var(--radius-sm);background:linear-gradient(135deg, var(--color-neutral-900), var(--color-section-ghost))"></div>
    <div style="flex:1;min-width:180px"><div style="font-family:var(--font-heading);font-weight:500;font-size:14.5px">${b.event_name}</div><div style="font-size:12px;color:var(--color-neutral-400)">${whenLabel(b.event_date)} · ${b.venue_name}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">${b.units} · booking #${b.booking_id} · made ${whenLabel(b.created_at)}</div></div>
    ${statusPill(b.booking_status)}
    <div style="font-family:var(--font-heading);font-weight:500;font-size:14px">${baht(b.total_amount)}</div>
    ${b.booking_status === 'Pending' ? html`<button data-click="${() => openBooking(b.booking_id, 'checkout')}" class="btn btn-primary" style="font-size:12.5px">Pay</button><button data-click="${() => cancelBooking(b.booking_id)}" class="btn btn-secondary" style="font-size:12.5px">Cancel</button>` : ''}
    ${b.booking_status === 'Paid' ? html`<button data-click="${() => openBooking(b.booking_id, 'confirm')}" class="btn btn-secondary" style="font-size:12.5px">View tickets</button>` : ''}
    ${b.booking_status === 'Expired' || b.booking_status === 'Cancelled' ? html`<button data-click="${() => openEvent(b.event_id)}" class="btn btn-secondary" style="font-size:12.5px">Try again</button>` : ''}
  </div>`)}
</div>`;
}

function authView() {
  const S = state, e = S.regTouched ? regErrors(S.reg) : {};
  return html`
<div class="pane" data-key="auth" style="display:flex;flex-wrap:wrap;justify-content:center;gap:var(--space-8);padding-top:var(--space-8)">
  <div style="width:min(400px,100%);padding:var(--space-8);border-radius:var(--radius-lg);${PANEL}">
    <h1 style="font-size:24px;margin:0">Choose your account</h1>
    <div style="font-size:12.5px;line-height:1.6;color:var(--color-neutral-400)">Login and passwords are out of scope for this prototype, so you pick who is booking.</div>
    <div style="display:flex;flex-direction:column;gap:var(--space-2);max-height:340px;overflow:auto">
      ${S.users.map(u => html`<button data-click="${() => chooseUser(u.user_id)}" style="${card(u.user_id === S.userId)}"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${u.full_name}</div><div style="font-size:11.5px;color:var(--color-neutral-500)">${u.email}${u.phone_number ? ' · ' + u.phone_number : ''}</div></button>`)}
    </div>
    <button data-click="${() => go('customer', 'browse')}" class="btn btn-ghost" style="font-size:12.5px">Keep browsing as a guest</button>
  </div>
  <div style="width:min(400px,100%);padding:var(--space-8);border-radius:var(--radius-lg);${PANEL}">
    <h1 style="font-size:24px;margin:0">New here? Register</h1>
    ${field('Full name', S.reg.full_name, set('reg', 'full_name'), { placeholder: 'Somchai Jaidee', error: e.full_name })}
    ${field('Email', S.reg.email, set('reg', 'email'), { placeholder: 'you@student.example.ac.th', error: e.email })}
    ${field('Phone (optional)', S.reg.phone_number, set('reg', 'phone_number'), { placeholder: '0812345678' })}
    <button data-click="${register}" class="btn btn-primary btn-block">Register &amp; continue</button>
    <div style="font-size:11.5px;color:var(--color-neutral-500)">Each email can register once (BR15).</div>
  </div>
</div>`;
}

/* — organizer — */

function organizerPicker() {
  const S = state, org = currentOrganizer();
  return html`
<div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap">
  <label style="font-size:12px;color:var(--color-neutral-400)">Acting as</label>
  <select data-input="${e => { local.set('organizer', e.target.value); setState({ organizerId: Number(e.target.value) }); }}" data-value="${S.organizerId || ''}" class="input" style="width:auto;min-width:220px">
    ${S.organizers.map(o => html`<option value="${o.organizer_id}">${o.organizer_name}</option>`)}
  </select>
  ${org ? statusPill(org.verification_status) : ''}
</div>
${org && org.verification_status !== 'Verified' ? html`<div style="${NOTE};border-color:var(--color-accent-700);color:var(--color-accent-300)">BR13: ${org.organizer_name} is ${org.verification_status}. An administrator must verify it before it can create events.</div>` : ''}`;
}

function dashView() {
  const S = state, org = currentOrganizer();
  const mine = S.allEvents.filter(e => org && e.organizer_id === org.organizer_id);
  const units = mine.reduce((t, e) => t + e.units, 0), sold = mine.reduce((t, e) => t + e.sold, 0), locked = mine.reduce((t, e) => t + e.locked, 0);
  return html`
<div class="pane" data-key="dash" style="display:flex;flex-direction:column;gap:var(--space-8)">
  <div style="display:flex;align-items:baseline;gap:var(--space-4);flex-wrap:wrap"><h1 style="font-size:28px;margin:0">Dashboard</h1><div style="font-size:12.5px;color:var(--color-neutral-500)">live from the database</div><button data-click="${() => go('organizer', 'create')}" class="btn btn-primary" style="margin-left:auto">+ Create event</button></div>
  ${organizerPicker()}
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--space-4)">
    ${kpi('Events', String(mine.length), mine.filter(e => e.event_status === 'On_sale').length + ' on sale (BR1)')}
    ${kpi('Units sold', String(sold), 'of ' + units + ' admission units')}
    ${kpi('On hold now', String(locked), 'locked for ' + CONFIG.holdMinutes + ' min (BR17)')}
    ${kpi('Sell-through', (units ? Math.round(sold / units * 100) : 0) + '%', mine.filter(e => e.units && e.sold === e.units).length + ' sold out')}
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-6);align-items:flex-start">
    <div style="flex:1;min-width:300px;display:flex;flex-direction:column;gap:var(--space-4)">
      <h4 style="font-size:16px;margin:0">Your events</h4>
      ${!mine.length ? html`<div style="${EMPTY}">No events yet.</div>` : ''}
      ${mine.map(e => {
        const pct = e.units ? Math.round(e.sold / e.units * 100) : 0;
        return html`
      <div style="display:flex;flex-direction:column;gap:var(--space-3);${BOX}">
        <div style="display:flex;align-items:baseline;gap:var(--space-3);flex-wrap:wrap"><div style="font-family:var(--font-heading);font-weight:500;font-size:15px">${e.event_name}</div>${statusPill(e.event_status)}<div style="margin-left:auto;font-size:12px;color:var(--color-neutral-500)">${whenLabel(e.event_date)}</div></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--color-neutral-400)"><span>${e.sold} of ${e.units} units sold · ${e.locked} on hold</span><span>${pct}%</span></div>
        ${bar(pct)}
        <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:center">
          <div style="font-size:11.5px;color:var(--color-neutral-500)">${e.seated_units} seated · ${e.standing_units} standing · capacity ${e.total_capacity}</div>
          <button data-click="${() => openEvent(e.event_id)}" class="btn btn-ghost" style="font-size:12px;margin-left:auto">Preview</button>
          ${e.event_status === 'Draft' || e.event_status === 'Closed' ? html`<button data-click="${() => setEventStatus(e.event_id, 'On_sale')}" class="btn btn-primary" style="font-size:12px">Open for sale</button>` : ''}
          ${e.event_status === 'On_sale' ? html`<button data-click="${() => setEventStatus(e.event_id, 'Closed')}" class="btn btn-secondary" style="font-size:12px">Close sales</button>` : ''}
          ${e.event_status !== 'Cancelled' ? html`<button data-click="${() => setEventStatus(e.event_id, 'Cancelled')}" class="btn btn-secondary" style="font-size:12px">Cancel</button>` : ''}
        </div>
      </div>`;
      })}
    </div>
    <div style="width:320px;flex:none;${BOX};display:flex;flex-direction:column;gap:var(--space-4)">
      <h4 style="font-size:16px;margin:0">Promotions</h4>
      ${S.promos.map(p => html`
      <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border:1px dashed var(--color-neutral-800);border-radius:var(--radius-sm)">
        <div style="flex:1;min-width:0"><div style="${MONO};font-size:12.5px">${p.coupon_code}</div><div style="font-size:11px;color:var(--color-neutral-500)">${promoLabel(p)} · ${dayLabel(p.start_date)} – ${dayLabel(p.end_date)}</div></div>
        <div style="font-size:11.5px;color:${p.active_today ? 'var(--color-accent-300)' : 'var(--color-neutral-600)'}">${p.active_today ? 'live' : 'off'} · ${p.times_used}</div>
      </div>`)}
      <button data-click="${() => go('organizer', 'offer')}" class="btn btn-primary btn-block" style="font-size:12.5px">+ New promotion</button>
    </div>
  </div>
</div>`;
}

function createView() {
  const S = state, n = S.n, p = eventPlan(n), e = S.nTouched ? eventErrors(n) : {}, org = currentOrganizer();
  const cap = Number(n.capacity) || 0, pct = cap ? Math.min(100, Math.round(p.total / cap * 100)) : 0;
  const setType = (name, k) => ev => setState({ n: Object.assign({}, n, { types: Object.assign({}, n.types, { [name]: Object.assign({}, n.types[name], { [k]: ev.target.value }) }) }) });
  const toggle = name => () => setState({ n: Object.assign({}, n, { types: Object.assign({}, n.types, { [name]: Object.assign({}, n.types[name], { on: !n.types[name].on }) }) }) });
  const box = on => 'width:16px;height:16px;flex:none;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:10px;border:1px solid ' + (on ? 'var(--color-accent)' : 'var(--color-neutral-700)') + ';background:' + (on ? 'var(--color-accent)' : 'transparent') + ';color:' + (on ? 'var(--color-accent-900)' : 'transparent');
  const check = (ok, text) => html`<div style="display:flex;gap:var(--space-2);font-size:11.5px;color:${ok ? 'var(--color-accent-300)' : 'var(--color-neutral-500)'}"><span>${ok ? '✓' : '○'}</span><span>${text}</span></div>`;
  return html`
<div class="pane" data-key="create" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Create an event', 'Creates a Draft with all its admission units. Open it for sale from the dashboard when you are ready.')}
  ${organizerPicker()}
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
    <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-4)">
      ${field('Event name', n.name, set('n', 'name'), { placeholder: 'SE Night Concert 2026', error: e.name })}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:var(--space-4)">
        ${field('Venue', n.venue, set('n', 'venue'), { placeholder: 'Main Hall, Building 30', error: e.venue })}
        ${field('Date', n.date, set('n', 'date'), { type: 'date', min: ymd(new Date()), error: e.date })}
        ${field('Start time', n.time, set('n', 'time'), { type: 'time' })}
        ${field('Total capacity', n.capacity, set('n', 'capacity'), { type: 'number', error: e.capacity })}
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <label style="font-size:12px;color:var(--color-neutral-400)">Ticket types — each can have numbered seats, a standing zone, or both</label>
        ${TYPE_NAMES.map(name => {
          const t = n.types[name];
          return html`
        <div style="display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-4) var(--space-6);border:1px solid ${t.on ? 'var(--color-accent-700)' : 'var(--color-neutral-800)'};border-radius:var(--radius-md);background:var(--color-surface)">
          <button data-click="${toggle(name)}" style="display:flex;align-items:center;gap:var(--space-3);border:0;background:none;padding:0;cursor:pointer;color:var(--color-text);font-family:var(--font-heading);font-weight:500;font-size:14px"><span style="${box(t.on)}">✓</span>${name}</button>
          ${t.on ? html`
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--space-3)">
            ${field('Price (฿)', t.price, setType(name, 'price'), { type: 'number' })}
            ${field('Seat rows', t.rows, setType(name, 'rows'), { placeholder: 'A, B' })}
            ${field('Seats per row', t.perRow, setType(name, 'perRow'), { type: 'number' })}
            ${field('Standing zone', t.zone, setType(name, 'zone'), { placeholder: 'Floor' })}
            ${field('Standing places', t.qty, setType(name, 'qty'), { type: 'number' })}
          </div>` : ''}
        </div>`;
        })}
        ${fieldError(e.types)}
      </div>
      <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;padding-top:var(--space-2)"><button data-click="${createEvent}" ${!org || org.verification_status !== 'Verified' ? html`disabled` : ''} class="btn btn-primary">Create draft</button><button data-click="${() => setState({ n: blankEvent(), nTouched: false })}" class="btn btn-ghost">Reset form</button></div>
    </div>
    <div style="width:320px;flex:none;display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Units this creates</h6>
      <div style="${BOX};display:flex;flex-direction:column;gap:var(--space-3)">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--color-neutral-400)"><span>Seated_Units</span><span>${p.seated}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--color-neutral-400)"><span>Standing_Units</span><span>${p.standing}</span></div>
        <div style="display:flex;justify-content:space-between;font-family:var(--font-heading);font-weight:500;font-size:15px"><span>Admission_Units</span><span>${p.total} / ${cap}</span></div>
        ${bar(pct, p.total > cap ? 'var(--color-accent-300)' : 'var(--color-accent)')}
      </div>
      <h6 style="margin:0;color:var(--color-neutral-500)">Checks the database will run</h6>
      <div style="${NOTE};display:flex;flex-direction:column;gap:6px">
        ${check(org && org.verification_status === 'Verified', 'BR13 — organizer is verified')}
        ${check(p.types.length > 0, 'BR11 — at least one ticket type with units')}
        ${check(p.types.length > 0 && p.types.every(t => t.price > 0), 'BR21 — every price is above zero')}
        ${check(!p.dupRow, 'BR16 — each row + seat is unique in the event')}
        ${check(cap > 0 && p.total <= cap, 'BR22 — units ≤ total capacity')}
        ${check(n.date && new Date(n.date + 'T' + (n.time || '00:00')) > new Date(), 'BR23 — the event is in the future')}
        ${check(p.types.length > 0 && p.types.every(t => t.seats || t.standing), 'BR10/BR25 — every unit is seated or standing')}
      </div>
    </div>
  </div>
</div>`;
}

function offerView() {
  const S = state, g = S.g, e = S.gTouched ? offerErrors(g) : {}, v = Number(g.value) || 0, base = 1000;
  const raw = g.type === 'Amount' ? v : base * v / 100;
  const disc = Math.min(base, g.type === 'Percent' && Number(g.cap) > 0 ? Math.min(raw, Number(g.cap)) : raw);
  return html`
<div class="pane" data-key="offer" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Create a promotion', 'A promotion works on any event while its dates are valid. Customers enter its code when they reserve.')}
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
    <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-6)">
      <div style="display:flex;flex-direction:column;gap:var(--space-3)">
        <label style="font-size:12px;color:var(--color-neutral-400)">Discount type — a promotion is exactly one of these (BR26)</label>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-3)">
          ${[['Amount', 'Amount_Discount', 'a flat baht amount off the booking'], ['Percent', 'Percent_Discount', 'a share of the booking, with an optional cap']].map(([key, label, note]) =>
            html`<button data-click="${() => setState({ g: Object.assign({}, g, { type: key }) })}" style="${card(g.type === key)}"><div style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${label}</div><div style="font-size:11px;color:var(--color-neutral-500)">${note}</div></button>`)}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--space-4)">
        ${field(g.type === 'Amount' ? 'Amount off (฿)' : 'Percent off (%)', g.value, set('g', 'value'), { type: 'number', error: e.value })}
        ${g.type === 'Percent' ? field('Max discount (฿, optional)', g.cap, set('g', 'cap'), { type: 'number', error: e.cap }) : ''}
        ${field('Code', g.code, set('g', 'code', x => x.toUpperCase()), { placeholder: 'EARLYBIRD', error: e.code, style: MONO + ';text-transform:uppercase' })}
        ${field('Start date', g.start, set('g', 'start'), { type: 'date' })}
        ${field('End date', g.end, set('g', 'end'), { type: 'date', error: e.end })}
      </div>
      <div style="display:flex;gap:var(--space-3);flex-wrap:wrap"><button data-click="${publishOffer}" class="btn btn-primary">Publish promotion</button><button data-click="${() => go('organizer', 'dash')}" class="btn btn-ghost">Cancel</button></div>
    </div>
    <div style="width:330px;flex:none;display:flex;flex-direction:column;gap:var(--space-4)">
      <h6 style="margin:0;color:var(--color-neutral-500)">Preview — a ${baht(base)} booking</h6>
      <div style="padding:var(--space-6);border:1px solid var(--color-neutral-800);border-radius:var(--radius-md);background:var(--color-surface);display:flex;flex-direction:column;gap:5px;font-size:12.5px">
        <div style="display:flex;justify-content:space-between;color:var(--color-neutral-400)"><span>Tickets</span><span>${baht(base)}</span></div>
        <div style="display:flex;justify-content:space-between;color:var(--color-accent-300)"><span>${g.code.trim() || 'CODE'} (${g.type === 'Amount' ? '−' + baht(v) : '−' + v + '%'})</span><span>−${baht(disc)}</span></div>
        <div style="display:flex;justify-content:space-between;font-family:var(--font-heading);font-weight:500;font-size:15px"><span>Total</span><span>${baht(base - disc)}</span></div>
      </div>
      <div style="${NOTE}">One promotion per booking (BR8), only on bookings made between the start and end dates (BR22). The discount given is stored with the booking and never recalculated (BR21).</div>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:var(--space-4)">
    <h4 style="font-size:16px;margin:0">All promotions</h4>
    <table class="table">
      <thead><tr><th>Code</th><th>Type</th><th>Discount</th><th>Valid</th><th>Today</th><th>Used</th></tr></thead>
      <tbody>${S.promos.map(p => html`<tr><td style="${MONO}">${p.coupon_code}</td><td>${p.discount_type}</td><td>${promoLabel(p)}</td><td>${dayLabel(p.start_date)} – ${dayLabel(p.end_date)}</td><td>${p.active_today ? html`<span style="${pill('ok')}">Valid</span>` : html`<span style="${pill('quiet')}">Not valid</span>`}</td><td>${p.times_used}</td></tr>`)}</tbody>
    </table>
  </div>
</div>`;
}

/* — manager — */

function salesView() {
  const S = state, r = S.reports;
  const byDay = new Map(r.daily.map(d => [d.day, d]));
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(byDay.get(ymd(d)) || { day: ymd(d), tickets_sold: 0, gross: 0 }); }
  const max = Math.max(1, ...days.map(d => d.tickets_sold));
  const tickets = days.reduce((t, d) => t + d.tickets_sold, 0), gross = days.reduce((t, d) => t + Number(d.gross), 0);
  const rev = S.revenue;
  return html`
<div class="pane" data-key="sales" style="display:flex;flex-direction:column;gap:var(--space-8)">
  ${h1('Sales — last 30 days', 'O1: every unit sold, with its sale time and price.')}
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--space-4)">
    ${kpi('Tickets sold', String(tickets), 'last 30 days')}
    ${kpi('Gross before discounts', baht(gross), 'sum of price_paid (BR21)')}
    ${kpi('Busiest day', String(Math.max(...days.map(d => d.tickets_sold))), 'tickets in one day')}
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:var(--space-6);align-items:stretch">
    <div style="flex:1;min-width:300px;display:flex;flex-direction:column;gap:var(--space-4);${BOX}">
      <h4 style="font-size:15px;margin:0">Tickets sold per day</h4>
      <div style="height:170px;display:flex;align-items:flex-end;gap:3px">${days.map((d, i) => html`<div title="${d.day}: ${plural(d.tickets_sold, 'ticket')} · ${baht(d.gross)}" style="flex:1;border-radius:2px 2px 0 0;min-height:2px;height:${Math.round(d.tickets_sold / max * 170)}px;background:${i === days.length - 1 ? 'var(--color-accent)' : d.tickets_sold ? 'var(--color-accent-700)' : 'var(--color-neutral-800)'}"></div>`)}</div>
      <div style="font-size:11.5px;color:var(--color-neutral-500)">${dayLabel(days[0].day + 'T00:00')} → today (bright bar)</div>
    </div>
    <div style="width:300px;flex:none;display:flex;flex-direction:column;gap:var(--space-4);${BOX}">
      <h4 style="font-size:15px;margin:0">Takings by payment method</h4>
      <select data-input="${e => { setState({ revenueEvent: e.target.value, revenue: null }); load('revenue'); }}" data-value="${S.revenueEvent}" class="input">
        <option value="">Choose an event…</option>
        ${S.allEvents.map(e => html`<option value="${e.event_id}">${e.event_name}</option>`)}
      </select>
      ${rev ? html`
      ${rev.by_method.map(m => html`<div style="display:flex;flex-direction:column;gap:4px"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--color-neutral-400)"><span>${m.payment_method} · ${plural(m.bookings, 'booking')}</span><span>${baht(m.collected)}</span></div>${bar(rev.total ? Math.round(m.collected / rev.total * 100) : 0)}</div>`)}
      ${!rev.by_method.length ? html`<div style="font-size:12px;color:var(--color-neutral-500)">No successful payments yet.</div>` : ''}
      <div style="display:flex;justify-content:space-between;font-family:var(--font-heading);font-weight:500;font-size:15px;padding-top:var(--space-2);border-top:1px solid var(--color-divider)"><span>Collected</span><span>${baht(rev.total)}</span></div>` : ''}
      <div style="font-size:11.5px;line-height:1.6;color:var(--color-neutral-500)">Only Successful payments count (BR19).</div>
    </div>
  </div>
  <div style="display:flex;flex-direction:column;gap:var(--space-4)">
    <h4 style="font-size:16px;margin:0">Every sale</h4>
    ${!r.sales.length ? html`<div style="${EMPTY}">No sales in the last 30 days.</div>` : html`
    <table class="table">
      <thead><tr><th>Sold at</th><th>Event</th><th>Type</th><th>Unit</th><th>Price paid</th><th>Buyer</th></tr></thead>
      <tbody>${r.sales.map(s => html`<tr><td>${whenLabel(s.sold_at)}</td><td>${s.event_name}</td><td>${s.type_name}</td><td>${s.unit_kind === 'Seated' ? 'Seat ' + s.row_label + s.seat_number : s.zone_name + ' (standing)'}</td><td>${baht(s.price_paid)}</td><td>${s.buyer}</td></tr>`)}</tbody>
    </table>`}
  </div>
</div>`;
}

function seatStatusView() {
  const rows = state.reports.seats;
  return html`
<div class="pane" data-key="seatstatus" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Seat status', 'O2: Available / Locked / Sold for every event (BR14), and which events are full.')}
  <table class="table">
    <thead><tr><th>Event</th><th>Status</th><th>Capacity</th><th>Available</th><th>Locked</th><th>Sold</th><th style="width:180px">Sold share</th><th>Full</th></tr></thead>
    <tbody>${rows.map(e => {
      const units = e.available + e.locked + e.sold, pct = units ? Math.round(e.sold / units * 100) : 0;
      return html`<tr><td>${e.event_name}</td><td>${statusPill(e.event_status)}</td><td>${e.total_capacity}</td><td>${e.available}</td><td>${e.locked}</td><td>${e.sold}</td><td>${bar(pct)}</td><td>${e.is_full ? html`<span style="${pill('ok')}">Full</span>` : html`<span style="${pill('quiet')}">No</span>`}</td></tr>`;
    })}</tbody>
  </table>
  <div style="${NOTE}">Events with no admission units yet are left out. Locked units belong to holds that end within ${CONFIG.holdMinutes} minutes (BR17, BR18).</div>
</div>`;
}

function usageView() {
  const rows = state.reports.usage;
  return html`
<div class="pane" data-key="usage" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Promotion usage', 'O4: each promotion, its valid period, and how many paid bookings used it.')}
  <table class="table">
    <thead><tr><th>Code</th><th>Type (BR26)</th><th>Valid</th><th>Times used</th><th>Discount given</th></tr></thead>
    <tbody>${rows.map(p => html`<tr><td style="${MONO}">${p.coupon_code}</td><td>${p.discount_type}</td><td>${dayLabel(p.start_date)} – ${dayLabel(p.end_date)}</td><td>${p.times_used}</td><td>${baht(p.total_discount_given)}</td></tr>`)}</tbody>
  </table>
</div>`;
}

function holdsView() {
  const S = state, r = S.reports, gone = Math.floor((S.now - r.fetchedAt) / 1000);
  return html`
<div class="pane" data-key="holds" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Unpaid holds', 'Bookings that are still Pending, how long they have waited, and when they expire (BR17, BR18).')}
  ${!r.pending.length ? html`<div style="${EMPTY}">No unpaid holds right now.</div>` : html`
  <table class="table">
    <thead><tr><th>Booking</th><th>User</th><th>Created</th><th>Waiting</th><th>Expires in</th><th>Total</th></tr></thead>
    <tbody>${r.pending.map(p => html`<tr><td>#${p.booking_id}</td><td>${p.full_name}</td><td>${whenLabel(p.created_at)}</td><td>${clock((p.seconds_waiting + gone) * 1000)}</td><td style="font-variant-numeric:tabular-nums;color:var(--color-accent-300)">${clock(Math.max(0, p.seconds_left - gone) * 1000)}</td><td>${baht(p.total_amount)}</td></tr>`)}</tbody>
  </table>`}
  <div style="${NOTE}">This list re-reads the database every ${CONFIG.refreshMs / 1000} seconds. A hold that runs out is marked Expired and its units return to Available.</div>
</div>`;
}

/* — administrator — */

function adminOrganizersView() {
  const S = state;
  return html`
<div class="pane" data-key="aorg" style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
  <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-4)">
    ${h1('Organizers', 'Only verified organizers can create events (BR13).')}
    <table class="table">
      <thead><tr><th>Organizer</th><th>Contact</th><th>Status</th><th>Verified</th><th></th></tr></thead>
      <tbody>${S.organizers.map(o => html`<tr><td>${o.organizer_name}</td><td>${o.contact_email}</td><td>${statusPill(o.verification_status)}</td><td>${o.verified_at ? dayLabel(o.verified_at) : '—'}</td><td style="text-align:right;white-space:nowrap">
        ${o.verification_status !== 'Verified' ? html`<button data-click="${() => verifyOrganizer(o.organizer_id, 'Verified')}" class="btn btn-primary" style="font-size:12px">Verify</button>` : ''}
        ${o.verification_status !== 'Rejected' ? html`<button data-click="${() => verifyOrganizer(o.organizer_id, 'Rejected')}" class="btn btn-ghost" style="font-size:12px">Reject</button>` : ''}
      </td></tr>`)}</tbody>
    </table>
  </div>
  <div style="width:320px;flex:none;${PANEL}">
    <h4 style="font-size:16px;margin:0">Register an organizer</h4>
    ${field('Name', S.orgForm.organizer_name, set('orgForm', 'organizer_name'), { placeholder: 'Photography Club' })}
    ${field('Contact email', S.orgForm.contact_email, set('orgForm', 'contact_email'), { placeholder: 'club@example.ac.th' })}
    <button data-click="${addOrganizer}" class="btn btn-primary btn-block">Register (starts Pending)</button>
  </div>
</div>`;
}

function adminUsersView() {
  const S = state, u = S.editUser;
  return html`
<div class="pane" data-key="ausers" style="display:flex;flex-wrap:wrap;gap:var(--space-8);align-items:flex-start">
  <div style="flex:1;min-width:320px;display:flex;flex-direction:column;gap:var(--space-4)">
    ${h1('Users', 'Correct a user’s details. Emails stay unique (BR15).')}
    <table class="table">
      <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Phone</th><th>Joined</th><th></th></tr></thead>
      <tbody>${S.users.map(x => html`<tr><td>${x.user_id}</td><td>${x.full_name}</td><td>${x.email}</td><td>${x.phone_number || '—'}</td><td>${dayLabel(x.created_at)}</td><td style="text-align:right"><button data-click="${() => setState({ editUser: Object.assign({}, x, { phone_number: x.phone_number || '' }) })}" class="btn btn-ghost" style="font-size:12px">Edit</button></td></tr>`)}</tbody>
    </table>
  </div>
  ${u ? html`
  <div style="width:320px;flex:none;${PANEL}">
    <h4 style="font-size:16px;margin:0">Edit user #${u.user_id}</h4>
    ${field('Full name', u.full_name, set('editUser', 'full_name'))}
    ${field('Email', u.email, set('editUser', 'email'))}
    ${field('Phone', u.phone_number, set('editUser', 'phone_number'))}
    <div style="display:flex;gap:var(--space-3)"><button data-click="${saveUser}" class="btn btn-primary">Save</button><button data-click="${() => setState({ editUser: null })}" class="btn btn-ghost">Cancel</button></div>
  </div>` : ''}
</div>`;
}

function adminEventsView() {
  const S = state;
  return html`
<div class="pane" data-key="aevents" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Events', 'Cancel an event, then remove it. Events with booking history are kept so sales still add up.')}
  <table class="table">
    <thead><tr><th>Event</th><th>Organizer</th><th>Date</th><th>Units</th><th>Sold</th><th>Status</th><th></th></tr></thead>
    <tbody>${S.allEvents.map(e => html`<tr><td>${e.event_name}</td><td>${e.organizer_name}</td><td>${whenLabel(e.event_date)}</td><td>${e.units}</td><td>${e.sold}</td><td>${statusPill(e.event_status)}</td><td style="text-align:right;white-space:nowrap">
      ${e.event_status !== 'Cancelled' ? html`<button data-click="${() => setEventStatus(e.event_id, 'Cancelled')}" class="btn btn-ghost" style="font-size:12px">Cancel</button>` : html`<button data-click="${() => removeEvent(e.event_id)}" class="btn btn-secondary" style="font-size:12px">Remove</button>`}
    </td></tr>`)}</tbody>
  </table>
</div>`;
}

/* — business rules — */

const RULES = [
  ['BR1', 'Relationship', 'An Organizer may create many Events; each Event has exactly one Organizer.', 'Host → Dashboard lists the acting organizer’s events.'],
  ['BR2', 'Relationship', 'Events offer catalog ticket types (Normal / Priority / VIP) through Event_Ticket_Types.', 'Event page “Ticket types”; Host → Create event.'],
  ['BR3', 'Relationship', 'Each Admission_Unit is priced by exactly one Event_Ticket_Type.', 'Seat tooltips and standing zones show the type and price.'],
  ['BR4', 'Relationship', 'A User makes many Bookings; each Booking has exactly one User.', 'Sign in to pick the user; Reservations lists theirs.'],
  ['BR5', 'Relationship', 'Bookings hold Admission_Units through Booking_items.', 'Checkout lists each unit in the booking.'],
  ['BR6', 'Relationship', 'A Booking may have many Payments; each Payment settles one Booking.', 'Checkout → “Payments on this booking”.'],
  ['BR7', 'Relationship', 'Each Booking_item produces at most one Ticket.', 'Confirmation shows one ticket code per unit.'],
  ['BR8', 'Relationship', 'A Booking applies at most one Promotion.', 'One promotion code field per reservation.'],
  ['BR9', 'Participation', 'Every Booking has at least one Booking_item.', 'Reserve is disabled until something is picked.'],
  ['BR10', 'Participation', 'Every Admission_Unit is a Seated_Unit or a Standing_Unit.', 'Seat map rows vs. standing zones.'],
  ['BR11', 'Participation', 'An Event needs a ticket type and units before it goes on sale.', 'Host → “Open for sale” is refused otherwise.'],
  ['BR12', 'Participation', 'Tickets are issued only for paid Bookings.', 'Ticket codes appear only after payment completes.'],
  ['BR13', 'Constraint', 'Only a verified Organizer may create Events.', 'Admin → Organizers verifies; Host → Create is blocked until then.'],
  ['BR14', 'Constraint', 'Status and type columns only take their allowed values.', 'Status pills everywhere; payment methods and results.'],
  ['BR15', 'Constraint', 'User email, catalog type name and ticket code are unique; a type appears once per event.', 'Register / Admin → Users refuse a used email.'],
  ['BR16', 'Constraint', 'A seat’s row + number is unique in its Event; a standing place has a zone instead.', 'Create event refuses a repeated row.'],
  ['BR17', 'Constraint', 'A Booking locks its units for 5 minutes from creation.', 'The hold bar countdown after Reserve.'],
  ['BR18', 'Constraint', 'Unpaid Bookings expire and free their units; paid ones make them Sold.', 'Let the timer run out — the units return to Available.'],
  ['BR19', 'Constraint', 'A Booking is Paid when its Successful Payments cover the total.', 'Pay part of it, or record a Failed payment.'],
  ['BR20', 'Constraint', 'A unit can be sold once and only once.', 'Sold seats can’t be picked; two buyers racing get one winner.'],
  ['BR21', 'Constraint', 'Prices are above zero; the price paid and the discount are fixed at sale.', 'Price paid shown per ticket; Manager → Sales.'],
  ['BR22', 'Constraint', 'Units never exceed capacity; a promotion works only inside its dates.', 'Create event capacity bar; expired codes are refused.'],
  ['BR23', 'Constraint', 'An Event is dated after it was created, and can’t be booked once it has happened.', 'Create event refuses past dates.'],
  ['BR24', 'Constraint', 'Tickets after the 2nd need an attendee name and ID; one ID per Event.', 'Seat picker asks for ID from the 3rd ticket.'],
  ['BR25', 'Specialisation', 'Admission_Unit is Seated or Standing — disjoint and total.', 'Event page “Where you can be”; Host → units preview.'],
  ['BR26', 'Specialisation', 'Promotion is Amount or Percent — disjoint and total.', 'Host → Promotions discount type.']
];

function rulesView() {
  return html`
<div class="pane" data-key="rules" style="display:flex;flex-direction:column;gap:var(--space-6)">
  ${h1('Business rules', 'The 26 rules from the proposal. MySQL enforces every one of them (schema.sql, triggers.sql, the booking transactions). This page shows where each one appears in Bookify.')}
  <table class="table">
    <thead><tr><th>#</th><th>Category</th><th>Rule</th><th>Where you see it</th></tr></thead>
    <tbody>${RULES.map(([id, cat, rule, where]) => html`<tr><td>${ruleTag(id)}</td><td style="font-size:12px;color:var(--color-neutral-400);white-space:nowrap">${cat}</td><td>${rule}</td><td style="font-size:12.5px;color:var(--color-neutral-400)">${where}</td></tr>`)}</tbody>
  </table>
</div>`;
}

function page() {
  const S = state;
  const views = {
    customer: { browse: browseView, event: eventView, seats: seatsView, checkout: checkoutView, confirm: confirmView, mine: mineView, auth: authView },
    organizer: { dash: dashView, create: createView, offer: offerView },
    manager: { sales: salesView, seats: seatStatusView, usage: usageView, holds: holdsView },
    admin: { organizers: adminOrganizersView, users: adminUsersView, events: adminEventsView }
  };
  const body = S.rules ? rulesView() : views[S.role][S[VIEW_KEY[S.role]]]();
  return html`
<div style="min-height:100vh;background:radial-gradient(120% 80% at 12% -10%, color-mix(in srgb, var(--color-accent) 9%, transparent), transparent 60%), var(--color-bg)">
  ${header()}
  <div data-key="main" style="max-width:1120px;margin:0 auto;padding:var(--space-8) var(--space-8) 64px">
    ${body}
  </div>
  ${S.toast ? html`<div data-key="toast" style="position:fixed;left:50%;bottom:28px;z-index:80;animation:toastIn .2s ease both;display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4) var(--space-6);border:1px solid var(--color-accent-700);border-radius:var(--radius-md);background:var(--color-accent-900);box-shadow:var(--shadow-lg);font-size:13px;color:var(--color-accent-100);max-width:min(460px,88vw)">${S.toast}</div>` : ''}
</div>`;
}

/* ─────────────────────────── render + boot ─────────────────────────── */

const root = document.getElementById('app');
const scratch = document.createElement('template');

function render() {
  renderQueued = false;
  handlers = [];
  scratch.innerHTML = page().s;
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

// Clock tick: countdowns, and BR18 — when a hold's time is up, ask the
// database (which expires it) instead of guessing in the browser.
setInterval(() => {
  setState({ now: Date.now() });
  const b = state.booking;
  if (b && b.booking_status === 'Pending' && Date.now() >= state.deadline && !state.expiring) {
    setState({ expiring: true });
    get('/bookings/' + b.booking_id).then(nb => {
      setBooking(nb);
      if (nb.booking_status === 'Expired') {
        say('The ' + CONFIG.holdMinutes + '-minute hold expired — those units went back on sale (BR18).', 5200);
        load('mine', 'event');
      } else if (nb.booking_status === 'Pending') {
        setState({ deadline: Date.now() + Math.max(1, nb.seconds_left) * 1000 });
      }
    }).catch(() => setState({ expiring: false }));
  }
}, 500);

// Keep open seat maps and hold lists in step with other buyers.
setInterval(() => {
  if (document.hidden || state.rules) return;
  if (state.role === 'customer' && (state.view === 'seats' || state.view === 'event')) loaders.event().catch(() => {});
  if (state.role === 'manager' && state.mview === 'holds') loaders.pending().catch(() => {});
}, CONFIG.refreshMs);

setInterval(() => {
  if (CONFIG.promoAutoRotate && state.role === 'customer' && state.view === 'browse' && !state.rules) {
    setState(s => ({ promo: (s.promo + 1) % Math.max(1, s.promos.filter(p => p.active_today).length) }));
  }
}, 6000);

render();
go('customer', 'browse');
load('users', 'mine').then(resumePendingHold);
