import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ROLE_PERMISSIONS = {
  admin: ['view', 'export', 'stock', 'edit', 'delete', 'reset', 'manageUsers'],
  manager: ['view', 'export', 'stock', 'edit'],
  viewer: ['view', 'export']
};
export const CATS = ['Electronics', 'Appliances', 'Furniture', 'Sports', 'Toiletries', 'Stationery'];
export const MAX_QTY = 10_000_000;
export const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

/** Calendar date (YYYY-MM-DD) in the institute's time zone, not the server's. */
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
export const newId = () => crypto.randomBytes(9).toString('base64url');
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const safeId = v => (typeof v === 'string' && ID_PATTERN.test(v) ? v : null);

/** Whole number within [min, MAX_QTY]; null when invalid. Rejects '', null, booleans and fractions. */
export function whole(v, min) {
  const ok = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
  const n = ok ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= min && n <= MAX_QTY ? n : null;
}
export function validDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const pad = n => String(n).padStart(2, '0');
export const GROUPS = [
  ['Guest rooms', Array.from({ length: 34 }, (_, i) => `Guest Room ${pad(i + 1)}`)],
  ['Lecture halls', Array.from({ length: 5 }, (_, i) => `Lecture Hall ${pad(i + 1)}`)],
  ['Conference rooms', ['Conference Room 01', 'Conference Room 02']],
  ['Office rooms', Array.from({ length: 3 }, (_, i) => `Office Room ${pad(i + 1)}`)],
  ['Shared spaces', ['Gym', 'Indoor Games Room', 'Dining Hall', 'Volleyball Court']]
];
export const LOCATIONS = GROUPS.flatMap(g => g[1]);
export const nameKey = name => String(name).trim().toLowerCase();

/** Original sample data from the JSON backend, plus the fields the Firestore model needs. */
export function buildSeed() {
  const now = new Date().toISOString();
  const mk = (name, category, qty, unit, min, alloc = {}, description = '') => ({
    id: newId(), name, nameKey: nameKey(name), category, qty, unit, min, description, alloc, roomMin: {}, sample: true, createdAt: now
  });
  const items = [
    mk('LED Television 43-inch', 'Electronics', 3, 'pcs', 2, { 'Guest Room 01': 1, 'Guest Room 02': 1, 'Lecture Hall 01': 1 }, 'Wall-mounted, with remote'),
    mk('Wireless Presenter Remote', 'Electronics', 6, 'pcs', 3, { 'Lecture Hall 02': 1, 'Conference Room 01': 1 }),
    mk('Projector', 'Electronics', 2, 'pcs', 2, { 'Lecture Hall 01': 1, 'Lecture Hall 03': 1, 'Conference Room 02': 1 }),
    mk('Electric Kettle', 'Appliances', 12, 'pcs', 6, { 'Guest Room 01': 1, 'Guest Room 02': 1, 'Dining Hall': 1 }),
    mk('Room Heater', 'Appliances', 4, 'pcs', 5, { 'Guest Room 05': 1, 'Guest Room 06': 1 }, 'Winter use'),
    mk('Water Dispenser', 'Appliances', 1, 'pcs', 1, { Gym: 1, 'Dining Hall': 2, 'Office Room 01': 1 }),
    mk('Office Chair', 'Furniture', 18, 'pcs', 8, { 'Office Room 01': 4, 'Office Room 02': 4, 'Office Room 03': 3 }),
    mk('Study Table', 'Furniture', 5, 'pcs', 4, { 'Guest Room 01': 1, 'Guest Room 02': 1 }),
    mk('Folding Table', 'Furniture', 0, 'pcs', 2, { 'Dining Hall': 6, 'Conference Room 01': 2 }),
    mk('Volleyball', 'Sports', 8, 'pcs', 4, { 'Volleyball Court': 3 }),
    mk('Badminton Racket', 'Sports', 10, 'pcs', 6, { 'Indoor Games Room': 6 }),
    mk('Yoga Mat', 'Sports', 3, 'pcs', 5, { Gym: 10 }),
    mk('Bath Soap', 'Toiletries', 140, 'bars', 60, {}, 'Guest room restocking'),
    mk('Shampoo Sachet', 'Toiletries', 45, 'pcs', 80, {}, 'Below threshold – reorder'),
    mk('Bath Towel', 'Toiletries', 60, 'pcs', 30, { 'Guest Room 01': 2, 'Guest Room 02': 2, 'Guest Room 03': 2 }),
    mk('A4 Paper Ream', 'Stationery', 30, 'reams', 15, { 'Office Room 01': 3, 'Office Room 02': 2 }),
    mk('Whiteboard Marker', 'Stationery', 50, 'pcs', 40, { 'Lecture Hall 01': 4, 'Lecture Hall 02': 4, 'Lecture Hall 03': 4 }),
    mk('Notepad', 'Stationery', 200, 'pcs', 100, { 'Conference Room 01': 10, 'Conference Room 02': 10 })
  ];
  const log = items.slice(0, 5).map((it, i) => ({
    id: newId(), ts: Date.now() - (i + 1) * 3600e3 * 7, date: today(), type: 'in', item: it.name, itemId: it.id,
    qty: it.qty, loc: '', note: 'Sample opening stock', actor: 'System', sample: true
  }));
  const locations = GROUPS.flatMap(([group, names], gi) => names.map((name, i) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, group, groupOrder: gi, order: i
  })));
  return { items, log, locations };
}
