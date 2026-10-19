// Kontrola v reálném prohlížeči (headless Chromium přes DevTools protokol, bez Playwrightu):
// screenshoty stránek na mobilu i desktopu + automatický audit přístupnosti axe-core (WCAG 2.1 A/AA).
// Umí se přihlásit (vývojová instalace s OTP_DEV_ZOBRAZIT=1 ukazuje SMS kód na stránce).
//
// Spuštění (viz docs/VYVOJ.md):
//   docker run -d --rm --name kontrola-chrome --network web zenika/alpine-chrome \
//     --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 \
//     --remote-debugging-port=9222 --remote-allow-origins=* about:blank
//   docker run --rm --network web -v $PWD:/app -v <výstup>:/out -w /app node:22-bookworm-slim \
//     node scripts/kontrola-prohlizecem.mjs http://platforma:3000 /out [telefon-admina]
// Přihlášení přes OIDC přesměrovává na BASE_URL instalace — pro dev za HTTP heslem použijte veřejnou adresu
// a AUTH=uzivatel:heslo (např. https://dev.vlastiborice.cz).
import { readFileSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';

const [base = 'http://platforma:3000', vystup = '/out', telefon = '777000001'] = process.argv.slice(2);
const chromeHost = process.env.CHROME_HOST ?? 'kontrola-chrome';
const ip = (await lookup(chromeHost)).address; // Chrome odmítá jiný Host než IP/localhost
const verze = await (await fetch(`http://${ip}:9222/json/version`)).json();
const ws = new WebSocket(verze.webSocketDebuggerUrl.replace(/\/\/[^/]+/, `//${ip}:9222`));
await new Promise((r, e) => ((ws.onopen = r), (ws.onerror = e)));

let id = 0;
const cekajici = new Map();
const udalosti = [];
ws.onmessage = (m) => {
  const z = JSON.parse(m.data);
  if (z.id && cekajici.has(z.id)) {
    const { r, e } = cekajici.get(z.id);
    cekajici.delete(z.id);
    if (z.error) e(new Error(z.error.message));
    else r(z.result);
  } else if (z.method) udalosti.push(z);
};
const cdp = (method, params = {}, sessionId) =>
  new Promise((r, e) => {
    const i = ++id;
    cekajici.set(i, { r, e });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await cdp('Target.attachToTarget', { targetId, flatten: true });
await cdp('Page.enable', {}, s);
await cdp('Runtime.enable', {}, s);
// instalace za HTTP heslem (dev): AUTH=uzivatel:heslo → hlavička pro všechny požadavky (OIDC přesměrovává na BASE_URL)
if (process.env.AUTH) {
  await cdp('Network.enable', {}, s);
  await cdp(
    'Network.setExtraHTTPHeaders',
    { headers: { authorization: 'Basic ' + Buffer.from(process.env.AUTH).toString('base64') } },
    s,
  );
}
const axe = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

const eval_ = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'chyba v prohlížeči');
  return r.result.value;
};
const pockejNaNacteni = async () => {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const stav = await eval_('document.readyState').catch(() => 'loading');
    if (stav === 'complete') return;
  }
};
const jdi = async (url) => {
  await cdp('Page.navigate', { url: url.startsWith('http') ? url : base + url }, s);
  await pockejNaNacteni();
  await new Promise((r) => setTimeout(r, 400));
};
const pockejNa = async (vyraz, ms = 15000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await eval_(vyraz).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Nedočkal jsem se: ${vyraz} (${await eval_('location.href').catch(() => '?')})`);
};
const odeslat = async (js) => {
  await eval_(js);
  await new Promise((r) => setTimeout(r, 300));
  await pockejNaNacteni();
};
const zarizeni = async (mobil) =>
  cdp(
    'Emulation.setDeviceMetricsOverride',
    mobil
      ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
      : { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false },
    s,
  );

async function snimek(nazev, celaStranka = true) {
  let clip;
  if (celaStranka) {
    const { contentSize } = await cdp('Page.getLayoutMetrics', {}, s);
    clip = { x: 0, y: 0, width: contentSize.width, height: Math.min(contentSize.height, 5000), scale: 1 };
  }
  const { data } = await cdp(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: !!celaStranka, clip },
    s,
  );
  writeFileSync(`${vystup}/${nazev}.png`, Buffer.from(data, 'base64'));
}

const vysledky = [];
async function audit(nazev) {
  await eval_(axe + ';0');
  const r = await eval_(
    `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, uzly: v.nodes.slice(0, 5).map(n => n.target.join(' ') + ' — ' + (n.failureSummary || '').split('\\n')[1]) })))`,
  );
  vysledky.push({ stranka: nazev, poruseni: r });
  console.log(
    `${nazev}: ${r.length ? r.map((v) => `${v.id} (${v.impact}, ${v.uzly.length})`).join(', ') : 'bez nálezů axe'}`,
  );
}

const verejne = (
  process.env.STRANKY ??
  '/,/aktuality,/uredni-deska,/povinne-informace,/kontakt,/hledat?q=hriste,/dotace,/akce,/galerie'
).split(',');
const nazevZ = (u) => (u === '/' ? 'titulka' : u.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-'));
for (const mobil of [false, true]) {
  await zarizeni(mobil);
  for (const u of verejne) {
    await jdi(u);
    await snimek(`${mobil ? 'mobil' : 'desktop'}-${nazevZ(u)}`);
    if (!mobil) await audit(u);
  }
}
// jedna aktualita a první stránka z menu
await zarizeni(false);
await jdi('/aktuality');
const clanek = await eval_(`(document.querySelector('.karta-clanku h3 a') || {}).href || ''`);
if (clanek) {
  await jdi(clanek);
  await snimek('desktop-aktualita');
  await audit('aktualita');
}
const strankaMenu = await eval_(`(document.querySelector('.pilulka li:nth-child(3) a') || {}).href || ''`);
if (strankaMenu) {
  await jdi(strankaMenu);
  await snimek('desktop-stranka-z-menu');
  await audit('stranka z menu');
}

// přihlášení a administrace
if (telefon !== '-') {
  await jdi('/prihlaseni');
  await pockejNa(`!!document.querySelector('#telefon') || location.pathname === '/ucet'`);
}
// prohlížeč může být přihlášený z minula (sdílené cookies) — pak se přihlašovací formulář přeskočí
if (telefon !== '-' && (await eval_(`location.pathname`)) !== '/ucet') {
  await odeslat(
    `document.querySelector('#telefon').value='${telefon}'; document.querySelector('#telefon').form.submit()`,
  );
  await pockejNa(`!!document.querySelector('#kod')`);
  const kod = await eval_(`(document.body.innerText.match(/kód z SMS je (\\d{6})/)||[])[1]||''`);
  if (!kod) throw new Error('Přihlášení: kód na stránce nenalezen (OTP_DEV_ZOBRAZIT?)');
  await odeslat(
    `document.querySelector('#kod').value='${kod}'; document.querySelector('#kod').form.submit()`,
  );
  await pockejNa(`!document.querySelector('#kod')`);
  await pockejNa(`document.readyState === 'complete'`);
  if (await eval_(`!!document.querySelector('[name=souhlas]')`))
    await odeslat(`document.querySelector('[name=souhlas]').form.submit()`);
}
if (telefon !== '-') {
  const admin = (
    process.env.ADMIN ??
    '/sprava,/sprava/web,/sprava/web/stranky,/sprava/web/novy?typ=aktualita,/sprava/deska,/sprava/deska/novy,/sprava/web/dotace,/sprava/povinne-informace'
  ).split(',');
  for (const mobil of [false, true]) {
    await zarizeni(mobil);
    for (const u of admin) {
      await jdi(u);
      await new Promise((r) => setTimeout(r, 600)); // editor (Quill) se inicializuje po načtení
      await snimek(`${mobil ? 'mobil' : 'desktop'}-sprava-${nazevZ(u)}`);
      if (!mobil) await audit(u);
    }
  }
}
// všechna barevná schémata a písma přes náhled vzhledu (jen přihlášený správce): axe + screenshot titulky
const schemata = (process.env.SCHEMATA ?? '').split(',').filter(Boolean);
for (const sch of schemata) {
  const [schema, pismo] = sch.split(':');
  await zarizeni(false);
  await jdi('/sprava/web/vzhled');
  await eval_(`(async () => { const f = document.querySelector('.vzhled-formular'); const d = new FormData(f);
    d.set('schema', '${schema}'); ${pismo ? `d.set('pismo', '${pismo}');` : ''} d.set('akce', 'nahled'); d.delete('pozadi'); d.delete('znak');
    await fetch(f.action, { method: 'POST', body: d, credentials: 'same-origin', redirect: 'manual' }); })()`);
  for (const u of (process.env.STRANKY_SCHEMATA ?? '/,/uredni-deska,/sprava/web/vzhled').split(',')) {
    await jdi(u);
    if (u === '/') await snimek(`schema-${schema}${pismo ? '-' + pismo : ''}`, false);
    await audit(`${u} [${sch}]`);
  }
}
if (schemata.length) {
  await jdi('/sprava/web/vzhled');
  await eval_(
    `fetch('/sprava/web/vzhled/nahled-zrusit', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + encodeURIComponent(document.querySelector('input[name=_csrf]').value) })`,
  );
}
writeFileSync(`${vystup}/axe.json`, JSON.stringify(vysledky, null, 2));
const celkem = vysledky.reduce((n, v) => n + v.poruseni.length, 0);
console.log(`Hotovo: ${vysledky.length} stránek, ${celkem} druhů porušení (podrobnosti v axe.json).`);
ws.close();
process.exit(0);
