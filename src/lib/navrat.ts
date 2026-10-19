// Bezpečné cíle přesměrování (ochrana před open redirect). Jediné místo, kde se rozhoduje, zda adresa z formuláře
// nebo z URL (?zpet=…) míří na vlastní web. Prohlížeč čte `\` jako `/`, takže `/\cizi.cz` je totéž co
// `//cizi.cz` (jiný server) — proto nestačí regex „začíná jedním lomítkem“.

const ZAKLAD = 'http://vlastni.invalid';

/** vlastní relativní cesta („/neco“), která po složení s naším původem zůstane na našem původu */
export function jeVlastniCesta(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (!s.startsWith('/') || s.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(s)) return false;
  try {
    return new URL(s, ZAKLAD).origin === ZAKLAD;
  } catch {
    return false;
  }
}

/** cíl návratu: vlastní cesta, jinak výchozí */
export function bezpecnyNavrat(zpet: unknown, vychozi = '/'): string {
  const s = typeof zpet === 'string' ? zpet : '';
  return jeVlastniCesta(s) ? s : vychozi;
}

/** odkaz zadaný správcem: vlastní cesta, nebo úplná adresa http(s) (jiné schéma, např. javascript:, ne) */
export function jeBezpecnyOdkaz(s: string): boolean {
  if (jeVlastniCesta(s)) return true;
  // eslint-disable-next-line no-control-regex
  if (!/^https?:\/\//i.test(s) || /[\\\s\u0000-\u001f\u007f]/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}
