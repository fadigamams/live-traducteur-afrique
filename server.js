const express = require("express"), { Pool } = require("pg"), path = require("path"), crypto = require("crypto");
const app = express(); app.set("trust proxy", 1);
const url = process.env.DATABASE_URL || "";
const pool = new Pool({ connectionString: url, ssl: url && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : false });
const ADMIN = process.env.ADMIN_KEY || "";
app.use(express.json({ limit: "400kb" }));
app.use((q, s, n) => { s.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" }); n(); });

const hits = new Map();
setInterval(() => hits.clear(), 3600e3);
function limit(q, s, n) {
  const a = (hits.get(q.ip) || []); if (a.length >= 40) return s.status(429).json({ error: "Trop de contributions, réessaie plus tard" });
  a.push(1); hits.set(q.ip, a); n();
}
function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const isAdmin = q => ADMIN.length >= 12 && !!q.get("x-admin-key") && safeEq(q.get("x-admin-key"), ADMIN);
const need = (q, s, n) => isAdmin(q) ? n() : s.status(401).json({ error: "Clé modérateur requise" });
const clean = (v, m) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, m);
const nk = s => clean(s, 300).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`'´]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const fail = (s, e) => { console.error(e); s.status(500).json({ error: "Erreur serveur" }); };

const INIT = `
create table if not exists entries(id text primary key, word text not null, lang text not null, meaning text not null, target text not null,
 example text default '', ctx text default '', pron text default '', region text default '', variants text default '', others text default '', cues text default '',
 status text not null default 'en attente', reports int default 0, created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists fixes(id serial primary key, entry_id text references entries(id) on delete cascade, text text not null, created_at timestamptz default now());
create table if not exists langs(code text primary key, name text not null, alt text default '', region text default '', descr text default '', created_at timestamptz default now());
create index if not exists e_word on entries(lower(word));
create table if not exists audios(entry_id text primary key references entries(id) on delete cascade, mime text not null, data bytea not null, created_at timestamptz default now());
create table if not exists edits(id serial primary key, entry_id text, before jsonb, created_at timestamptz default now());`;
const SEL = `select e.id,e.word,e.lang,e.meaning,e.target,e.example,e.ctx,e.pron,e.region,e.variants,e.others,e.cues,e.status,e.reports,
 e.created_at as "createdAt", e.updated_at as "updatedAt", exists(select 1 from audios a where a.entry_id=e.id) as "hasAudio",
 (select coalesce(json_agg(json_build_object('text',f.text,'date',f.created_at) order by f.id),'[]'::json) from fixes f where f.entry_id=e.id) as fixes from entries e`;

app.get("/api/entries", async (q, s) => {
  try { s.json((await pool.query(SEL + (isAdmin(q) ? "" : " where e.status<>'supprimé'") + " order by e.created_at")).rows); } catch (e) { fail(s, e); }
});
app.post("/api/entries", limit, async (q, s) => {
  try {
    const b = q.body || {}, w = clean(b.word, 200), m = clean(b.meaning, 300), lg = clean(b.lang, 40), tg = clean(b.target, 40);
    if (!w || !m || !lg || !tg || lg === tg) return s.status(400).json({ error: "Champs invalides" });
    const id = /^[a-z0-9_-]{6,40}$/i.test(b.id || "") ? b.id : "e" + crypto.randomBytes(6).toString("hex");
    const PLH = "(à transcrire)";
    const ex = w === PLH ? { rows: [] } : await pool.query("select word,meaning from entries where lang=$1 and target=$2 and lower(word)=lower($3) and status<>'supprimé'", [lg, tg, w]);
    if (ex.rows.some(r => nk(r.word) === nk(w) && nk(r.meaning) === nk(m))) return s.status(409).json({ error: "Déjà enregistré" });
    await pool.query("insert into entries(id,word,lang,meaning,target,example,ctx,pron,region,variants,others,cues) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do nothing",
      [id, w, lg, m, tg, clean(b.example, 300), clean(b.ctx, 200), clean(b.pron, 100), clean(b.region, 100), clean(b.variants, 200), clean(b.others, 500), clean(b.cues, 200)]);
    s.status(201).json({ ok: true, id });
  } catch (e) { fail(s, e); }
});
app.post("/api/entries/:id/report", limit, async (q, s) => {
  try {
    await pool.query("update entries set reports=reports+1, status=case when status='validé' and reports+1>=3 then 'à corriger' else status end, updated_at=now() where id=$1 and status<>'supprimé'", [q.params.id]);
    s.json({ ok: true });
  } catch (e) { fail(s, e); }
});
app.post("/api/entries/:id/fix", limit, async (q, s) => {
  try {
    const t = clean((q.body || {}).text, 500); if (!t) return s.status(400).json({ error: "Texte vide" });
    const n = await pool.query("select count(*)::int c from fixes where entry_id=$1", [q.params.id]);
    if (n.rows[0].c >= 20) return s.status(429).json({ error: "Déjà beaucoup de corrections proposées" });
    await pool.query("insert into fixes(entry_id,text) select id,$2 from entries where id=$1 and status<>'supprimé'", [q.params.id, t]);
    s.json({ ok: true });
  } catch (e) { fail(s, e); }
});
const MIMES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"];
app.post("/api/entries/:id/audio", limit, async (q, s) => {
  try {
    const b = q.body || {}, mime = String(b.mime || "").split(";")[0].toLowerCase();
    if (!MIMES.includes(mime) || typeof b.b64 !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b.b64)) return s.status(400).json({ error: "Audio invalide" });
    const buf = Buffer.from(b.b64, "base64");
    if (!buf.length || buf.length > 250000) return s.status(413).json({ error: "Audio trop long (8 secondes maximum)" });
    const e = await pool.query("select 1 from entries where id=$1 and status<>'supprimé'", [q.params.id]);
    if (!e.rows.length) return s.status(404).json({ error: "Mot introuvable" });
    await pool.query("insert into audios(entry_id,mime,data) values($1,$2,$3) on conflict(entry_id) do nothing", [q.params.id, mime, buf]);
    s.status(201).json({ ok: true });
  } catch (e) { fail(s, e); }
});
app.get("/api/entries/:id/audio", async (q, s) => {
  try {
    const r = await pool.query("select a.mime,a.data from audios a join entries e on e.id=a.entry_id where a.entry_id=$1" + (isAdmin(q) ? "" : " and e.status<>'supprimé'"), [q.params.id]);
    if (!r.rows.length) return s.status(404).end();
    s.set({ "Content-Type": r.rows[0].mime, "Cache-Control": "public, max-age=3600", "Content-Disposition": "inline" });
    s.send(r.rows[0].data);
  } catch (e) { fail(s, e); }
});
app.delete("/api/entries/:id/audio", need, async (q, s) => { // retrait d'une voix (modérateur)
  try { await pool.query("delete from audios where entry_id=$1", [q.params.id]); s.json({ ok: true }); } catch (e) { fail(s, e); }
});
app.get("/api/langs", async (q, s) => { try { s.json((await pool.query("select code,name,alt,region,descr from langs order by created_at")).rows); } catch (e) { fail(s, e); } });
app.post("/api/langs", limit, async (q, s) => {
  try {
    const b = q.body || {}, name = clean(b.name, 80), code = clean(b.code, 30).toLowerCase();
    if (!name || !/^[a-z0-9-]{1,30}$/.test(code)) return s.status(400).json({ error: "Langue invalide" });
    await pool.query("insert into langs(code,name,alt,region,descr) values($1,$2,$3,$4,$5) on conflict(code) do nothing", [code, name, clean(b.alt, 100), clean(b.region, 100), clean(b.desc, 300)]);
    s.status(201).json({ ok: true });
  } catch (e) { fail(s, e); }
});
// --- modération (clé secrète ADMIN_KEY, jamais dans le HTML) ---
app.get("/api/admin/check", need, (q, s) => s.json({ ok: true }));
const EDITABLE = { word: 200, meaning: 300, lang: 40, target: 40, example: 300, ctx: 200, pron: 100, region: 100, variants: 200, others: 500, cues: 200 };
const STATUTS = ["en attente", "validé", "refusé", "à corriger"];
// modification par un modérateur : effective tout de suite, ancienne version conservée dans "edits"
app.patch("/api/entries/:id", need, async (q, s) => {
  try {
    const b = q.body || {}, sets = [], vals = [q.params.id], nv = {};
    const old = await pool.query("select * from entries where id=$1", [q.params.id]);
    if (!old.rows.length) return s.status(404).json({ error: "Mot introuvable" });
    if (b.status !== undefined) {
      if (!STATUTS.includes(b.status)) return s.status(400).json({ error: "Statut invalide" });
      vals.push(b.status); sets.push("status=$" + vals.length);
    }
    for (const k of Object.keys(EDITABLE)) {
      if (b[k] === undefined) continue;
      const v = clean(b[k], EDITABLE[k]);
      if (["word", "meaning", "lang", "target"].includes(k) && !v) return s.status(400).json({ error: "Champ obligatoire vide : " + k });
      nv[k] = v; vals.push(v); sets.push(k + "=$" + vals.length);
    }
    if (!sets.length) return s.status(400).json({ error: "Rien à modifier" });
    const m = { ...old.rows[0], ...nv };
    if (m.lang === m.target) return s.status(400).json({ error: "Langues identiques" });
    await pool.query("insert into edits(entry_id,before) values($1,$2::jsonb)", [q.params.id, JSON.stringify(old.rows[0])]);
    await pool.query("update entries set " + sets.join(",") + ", updated_at=now() where id=$1", vals);
    s.json({ ok: true });
  } catch (e) { fail(s, e); }
});
app.delete("/api/entries/:id", need, async (q, s) => { // suppression douce : récupérable
  try { await pool.query("update entries set status='supprimé', updated_at=now() where id=$1", [q.params.id]); s.json({ ok: true }); } catch (e) { fail(s, e); }
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));
const port = process.env.PORT || 3000;
pool.query(INIT).then(() => app.listen(port, () => console.log("TAL sur le port " + port)))
  .catch(e => { console.error("Base de données inaccessible :", e.message); process.exit(1); });
