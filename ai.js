/* =========================================================
   Photo reading — Site Manager and Supervisor app
   Sends a photo (hour meter, log-book page, bill) to Google's Gemini model
   and gets the numbers back as data. The admin pastes a free Gemini API key
   once (Menu → Photo reading); it is kept in the online database
   (sm_meta/ai), readable only by people with a login.
   ========================================================= */
const API = 'https://generativelanguage.googleapis.com/v1beta/';
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
const STRONG = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

let CFG = null, CFG_AT = 0;
export async function aiConfig(cloud, fresh) {
  if (CFG && !fresh && Date.now() - CFG_AT < 10 * 60 * 1000) return CFG;
  const d = await cloud.getDocServer('sm_meta/ai');
  CFG = d && d.key ? { key: String(d.key).trim(), models: Array.isArray(d.models) ? d.models.filter(Boolean) : [] } : null; CFG_AT = Date.now();
  return CFG;
}
export function aiForget() { CFG = null; CFG_AT = 0; }

/* ---------- photo → small JPEG (base64) ---------- */
export function pickPhoto() {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
    inp.addEventListener('change', () => { res(inp.files && inp.files[0] || null); inp.remove(); });
    inp.addEventListener('cancel', () => { res(null); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  });
}
export async function toJpeg(file, max = 2000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This file is not a photo the phone can open.')); i.src = url; });
    const sc = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    const data = c.toDataURL('image/jpeg', 0.85);
    return { b64: data.split(',')[1], preview: data };
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- the model call ---------- */
function plainError(e) {
  const s = e.status || 0, m = String(e.message || '');
  if (e.offline) return 'Photo reading needs the internet.';
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'The photo-reading key is not valid. The admin can paste it again in Menu → Photo reading.';
  if (s === 429) return "Today's free photo-reading limit is used up. Type the numbers in, or try again tomorrow.";
  if (s === 403) return 'Google refused the photo-reading key (' + m.slice(0, 120) + ').';
  if (s === 400) return 'Google could not read this photo (' + m.slice(0, 120) + ').';
  return 'Photo reading failed: ' + (m.slice(0, 140) || 'unknown error');
}
async function call(key, model, parts) {
  let r;
  try {
    r = await fetch(API + 'models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } })
    });
  } catch (e) { const x = new Error('offline'); x.offline = true; throw x; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const x = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); x.status = r.status; throw x; }
  const c = j.candidates && j.candidates[0];
  const text = ((c && c.content && c.content.parts) || []).map(p => p.text || '').join('');
  if (!text) { const x = new Error(c && c.finishReason ? 'no answer (' + c.finishReason + ')' : 'empty answer'); x.status = 400; throw x; }
  return text;
}
async function discover(key) {
  try {
    const r = await fetch(API + 'models?pageSize=200&key=' + encodeURIComponent(key)); if (!r.ok) return [];
    const j = await r.json();
    return (j.models || []).filter(m => /flash/i.test(m.name) && !/image|tts|audio|live|embedding|preview/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, '')).sort((a, b) => (/lite/.test(b) - /lite/.test(a)) || b.localeCompare(a));
  } catch (e) { return []; }
}
/* tries the models in order: a model that is unknown, busy or out of free quota hands over to the next */
async function generate(cfg, parts, strong) {
  if (window.SM_AI_MOCK) return window.SM_AI_MOCK(parts);
  let list = [...new Set([...(cfg.models || []), ...(strong ? STRONG : MODELS)])], tried = new Set(), last = null, found = false;
  for (let round = 0; round < 2; round++) {
    for (const m of list) {
      if (tried.has(m)) continue; tried.add(m);
      try { const t = await call(cfg.key, m, parts); return { text: t, model: m }; }
      catch (e) { last = e; if (e.offline || /API key not valid|API_KEY_INVALID/i.test(e.message)) throw new Error(plainError(e)); if (![404, 429, 500, 503].includes(e.status)) throw new Error(plainError(e)); }
    }
    if (found) break; found = true;
    list = await discover(cfg.key);   // model names change: ask Google which ones this key can use
  }
  throw new Error(plainError(last || new Error('no model available')));
}
export async function testKey(key) {
  const out = await generate({ key, models: [] }, [{ text: 'Reply with this JSON only: {"ok":true}' }]);
  return out.model;
}
const parseJson = t => {
  const s = String(t).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch (e) { }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { }
  throw new Error('The answer from photo reading was not readable. Try again or type it in.');
};

/* ---------- what we ask for ---------- */
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function machinePrompt(ctx) {
  const ms = (ctx.machines || []).map(m => m.no + (m.type ? ' (' + m.type + ')' : '')).join(', ');
  return `You read photos taken on a construction site in Maharashtra, India, for a machine-hours log app.
The photo is one of:
(a) "meter": the hour meter / service meter display of ONE machine (excavator "Poclain", JCB, Hiwa dumper, tractor, bulldozer, generator). It shows engine hours, often with one decimal (for example 13618.1; a mechanical counter may show the last digit in a different colour = tenths).
(b) "log": a handwritten or printed log-book page or register, in English, Marathi or Hindi, with one row per day (or per machine): date, start / in / opening reading, close / out / closing reading, hours, diesel litres, remarks. Column words may be In, Start, Opening, Sur, सुरुवात, Out, Close, Closing, Band, बंद, Total, HSD, Diesel, डिझेल, Ltr.
(c) "other": anything else.
Context:
- Site: ${ctx.site || '-'}. Today: ${ctx.today || todayStr()}.
- Machine the user has open: ${ctx.machineNo ? ctx.machineNo + (ctx.machineType ? ' (' + ctx.machineType + ')' : '') : 'none'}.${ctx.lastOut != null && ctx.lastOut !== '' ? `
- Last saved out reading of that machine: ${ctx.lastOut}${ctx.lastDate ? ' on ' + ctx.lastDate : ''}. Readings only go up.` : ''}
- Machines on this site: ${ms || '-'}.
Rules:
- Dates are written day first (DD/MM, DD-MM-YY, DD.MM). If the year is missing, use the year that makes the date not later than today.
- Copy numbers exactly as written, as plain numbers without thousands separators. Do not guess: use null when a value is missing, crossed out or unreadable.
- If a row or the photo names a machine (PC-10, PC 10, JCB 2, HW 3585, Hiwa MH12AB3585), copy it into machineNo as written; otherwise "".
- Ignore header rows, total rows and the hours column (hours are worked out from in and out).
- For a meter photo put the reading in meterReading and leave rows empty.
Answer with JSON only, in this shape:
{"kind":"meter"|"log"|"other","meterReading":number|null,"rows":[{"date":"YYYY-MM-DD"|null,"machineNo":"","inR":number|null,"outR":number|null,"diesel":number|null,"remark":""}],"note":"one short English sentence about anything unclear, or empty"}`;
}
function billPrompt(ctx) {
  return `You read photos of bills, receipts, cash memos and delivery slips from a construction site in Maharashtra, India (printed or handwritten; English, Marathi or Hindi).
${ctx.kind === 'diesel' ? 'This should be a diesel (HSD) bill from a petrol pump or a tanker delivery slip.' : 'This is a bill for a site expense (material, hardware, food, transport, repairs, labour and so on).'}
Context: today is ${ctx.today || todayStr()}.${ctx.vendors && ctx.vendors.length ? ' Known vendors: ' + ctx.vendors.join(', ') + '.' : ''}${ctx.categories && ctx.categories.length ? ' Expense categories: ' + ctx.categories.join(', ') + '.' : ''}
Rules:
- Dates are day first (DD/MM/YY). If the year is missing, use the year that makes the date not later than today.
- amount = the final total payable in rupees (after tax), a plain number. litres = total diesel quantity. rate = price per litre if shown.
- vendor = the shop / pump / supplier name as printed. If it is clearly one of the known vendors, use that exact known name.
- category = the best match from the expense categories, or "" if none fits or this is diesel.
- items = a short English description of what was bought (max 8 words).
- Use null or "" when something is not on the bill. Do not guess numbers.
Answer with JSON only:
{"date":"YYYY-MM-DD"|null,"vendor":"","billNo":"","litres":number|null,"rate":number|null,"amount":number|null,"items":"","category":"","note":"one short English sentence about anything unclear, or empty"}`;
}

const numOr = v => { if (v === null || v === undefined || v === '') return ''; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,\s₹]/g, '')); return isFinite(n) ? n : ''; };
const okDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';

export async function readMachinePhoto(cloud, b64, ctx, strong) {
  const cfg = await aiConfig(cloud); if (!cfg) throw new Error('NO_KEY');
  const out = await generate(cfg, [{ text: machinePrompt(ctx) }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }], strong);
  const j = parseJson(out.text);
  const rows = (Array.isArray(j.rows) ? j.rows : []).map(r => ({ date: okDate(r.date), machineNo: String(r.machineNo || '').trim(), inR: numOr(r.inR), outR: numOr(r.outR), diesel: numOr(r.diesel), remark: String(r.remark || '').trim() }))
    .filter(r => r.inR !== '' || r.outR !== '' || r.diesel !== '' || r.remark);
  return { kind: ['meter', 'log', 'other'].includes(j.kind) ? j.kind : (rows.length ? 'log' : 'other'), meterReading: numOr(j.meterReading), rows, note: String(j.note || '').trim(), model: out.model };
}
export async function readBillPhoto(cloud, b64, ctx, strong) {
  const cfg = await aiConfig(cloud); if (!cfg) throw new Error('NO_KEY');
  const out = await generate(cfg, [{ text: billPrompt(ctx) }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }], strong);
  const j = parseJson(out.text);
  return { date: okDate(j.date), vendor: String(j.vendor || '').trim(), billNo: String(j.billNo || '').trim(), litres: numOr(j.litres), rate: numOr(j.rate), amount: numOr(j.amount), items: String(j.items || '').trim(), category: String(j.category || '').trim(), note: String(j.note || '').trim(), model: out.model };
}

/* ---------- matching what was read to the app's own lists ---------- */
export const machineKey = s => String(s || '').toLowerCase().replace(/hiwa/g, 'hw').match(/[a-z]+|\d+/g)?.map(x => /^\d+$/.test(x) ? String(parseInt(x, 10)) : x).join('') || '';
export function matchMachine(list, written) {
  const k = machineKey(written); if (!k) return '';
  const hit = list.find(m => machineKey(m.no) === k);
  if (hit) return hit.no;
  /* "HW MH12AB3585" style: match on the last number group */
  const tail = (String(written).match(/\d+/g) || []).pop();
  if (tail && tail.length >= 3) { const h = list.filter(m => (String(m.no).match(/\d+/g) || []).pop() === tail); if (h.length === 1) return h[0].no; }
  return '';
}
const nk = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(petroleums?|petroliums?|petrol|pump|co|ltd|pvt|m s|ms|the|and|dealers?|filling station)\b/g, ' ').replace(/\s+/g, ' ').trim();
const cp = s => nk(s).replace(/ /g, '');
export function matchName(list, written) {
  const w = nk(written); if (!w) return '';
  let best = '', score = 0;
  for (const v of list || []) {
    const n = nk(v); if (!n) continue;
    if (n === w || cp(v) === cp(written)) return v;
    const a = new Set(w.split(' ')), b = n.split(' ');
    const common = b.filter(x => a.has(x) && x.length > 1).length;
    const sc = common / Math.max(b.length, a.size);
    if ((n.includes(w) || w.includes(n)) && Math.min(n.length, w.length) >= 3) { if (0.9 > score) { score = 0.9; best = v; } }
    else if (sc > score) { score = sc; best = v; }
  }
  return score >= 0.5 ? best : '';
}
