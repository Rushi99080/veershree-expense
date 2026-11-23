/* Totals worked out exactly the way the old Plot Expense Manager did, used by the import check.
   Pure functions: give it { sites, people, exp, mlog, dsl, vpay, opay, bill, fund } and it returns totals. */
const num = v => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/rs\.?|₹|,|\s/gi, ''));
  return isFinite(n) ? n : 0;
};
const has = v => v !== '' && v != null;
const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const hrsOf = r => (has(r.inR) && has(r.outR)) ? Math.max(0, num(r.outR) - num(r.inR)) : num(r.hrs);
const billTotal = b => (b.lines || []).reduce((a, l) => a + num(l && l.amount), 0);
const eq = (a, b) => Math.round(num(a) * 100) === Math.round(num(b) * 100);
const COLLS = ['exp', 'mlog', 'dsl', 'vpay', 'opay', 'bill', 'fund'];

function summary(d) {
  const arr = k => Array.isArray(d[k]) ? d[k] : [];
  const S = new Map();
  const site = id => {
    const k = id || ''; let v = S.get(k);
    if (!v) { const s = arr('sites').find(x => x.id === k); v = { id: k, name: s ? s.name : (k ? 'Site not in list (' + k + ')' : 'No site'), exp: 0, dsl: 0, dslL: 0, rent: 0, comm: 0, vpay: 0, opay: 0, hrs: 0, n: 0 }; S.set(k, v); }
    return v;
  };
  const H = new Map(); const addH = (k, v) => H.set(k, (H.get(k) || 0) + num(v));
  const P = new Map();
  const person = name => {
    const k = norm(name); let v = P.get(k);
    if (!v) { const p = arr('people').find(x => norm(x.name) === k); v = { key: k, name: p ? p.name : String(name).trim(), rec: 0, spent: 0 }; P.set(k, v); }
    return v;
  };
  arr('people').forEach(p => person(p.name));
  for (const r of arr('exp')) { const s = site(r.site); s.exp += num(r.amount); s.n++; addH(r.cat || 'Uncategorised', r.amount); if (r.status === 'Paid' && r.paidBy) person(r.paidBy).spent += num(r.amount); }
  for (const r of arr('dsl')) { const s = site(r.site); s.dsl += num(r.amount); s.dslL += num(r.litres); s.n++; if (r.status === 'Paid' && r.paidBy) person(r.paidBy).spent += num(r.amount); }
  for (const b of arr('bill')) { const s = site(b.site); s.rent += billTotal(b); s.comm += num(b.comm); s.n++; }
  for (const r of arr('vpay')) { const s = site(r.site); s.vpay += num(r.amount); s.n++; if (r.paidBy) person(r.paidBy).spent += num(r.amount); }
  for (const r of arr('opay')) { const s = site(r.site); s.opay += num(r.amount); s.n++; if (r.paidBy) person(r.paidBy).spent += num(r.amount); }
  for (const r of arr('mlog')) { const s = site(r.site); s.hrs += hrsOf(r); s.n++; }
  for (const f of arr('fund')) { if (!f.person) continue; person(f.person).rec += num(f.amount); }
  const dsl = arr('dsl').reduce((a, r) => a + num(r.amount), 0); if (dsl) H.set('Diesel', dsl);
  const rent = arr('bill').reduce((a, b) => a + billTotal(b), 0); if (rent) H.set('Machine rent (bills)', rent);
  const sites = [...S.values()];
  const g = k => sites.reduce((a, s) => a + s[k], 0);
  const grand = { exp: g('exp'), dsl: g('dsl'), rent: g('rent'), comm: g('comm'), vpay: g('vpay'), opay: g('opay'), hrs: g('hrs') };
  grand.cost = grand.exp + grand.dsl + grand.rent;
  grand.n = COLLS.reduce((a, c) => a + arr(c).length, 0);
  const counts = Object.fromEntries(COLLS.map(c => [c, arr(c).length]));
  return { sites, heads: H, people: [...P.values()].map(p => ({ ...p, bal: p.rec - p.spent })), counts, grand };
}

function compare(A, B) {
  const F = ['exp', 'dsl', 'dslL', 'rent', 'comm', 'vpay', 'opay', 'hrs'];
  const ids = [...new Set([...A.sites.map(s => s.id), ...B.sites.map(s => s.id)])];
  const z = { exp: 0, dsl: 0, dslL: 0, rent: 0, comm: 0, vpay: 0, opay: 0, hrs: 0, n: 0 };
  const sites = ids.map(id => {
    const a = A.sites.find(s => s.id === id) || { ...z, id, name: '' }, b = B.sites.find(s => s.id === id) || { ...z, id, name: '' };
    return { id, name: a.name || b.name, a, b, ok: F.every(k => eq(a[k], b[k])) && a.n === b.n };
  }).sort((x, y) => (y.a.exp + y.a.dsl + y.a.rent) - (x.a.exp + x.a.dsl + x.a.rent));
  const hl = [...new Set([...A.heads.keys(), ...B.heads.keys()])];
  const heads = hl.map(label => ({ label, a: A.heads.get(label) || 0, b: B.heads.get(label) || 0 })).map(h => ({ ...h, ok: eq(h.a, h.b) })).sort((x, y) => y.a - x.a);
  const pk = [...new Set([...A.people.map(p => p.key), ...B.people.map(p => p.key)])];
  const zp = { rec: 0, spent: 0, bal: 0 };
  const people = pk.map(k => { const a = A.people.find(p => p.key === k) || { ...zp, name: '' }, b = B.people.find(p => p.key === k) || { ...zp, name: '' }; return { name: a.name || b.name, a, b, ok: eq(a.rec, b.rec) && eq(a.spent, b.spent) }; })
    .filter(p => p.a.rec || p.a.spent || p.b.rec || p.b.spent || !p.ok);
  const counts = COLLS.map(k => ({ k, a: A.counts[k], b: B.counts[k], ok: A.counts[k] === B.counts[k] }));
  const all = [...sites, ...heads, ...people, ...counts];
  return { sites, heads, people, counts, n: all.length, bad: all.filter(x => !x.ok).length };
}

export const OldCalc = { summary, compare, eq, num, hrsOf, billTotal };
