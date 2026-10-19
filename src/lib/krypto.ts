// Hesla (scrypt z Node — bez nativních závislostí), náhodné tokeny a kódy.
import {
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
  createHmac,
  type ScryptOptions,
} from 'node:crypto';

// Parametry podle OWASP (Password Storage Cheat Sheet): N=2^15, r=8, p=3 je rovnocenné N=2^17, p=1, ale potřebuje
// jen 32 MiB paměti na jedno ověření (2^17 by bralo 128 MiB — pár souběžných přihlášení by malý server vyčerpalo).
// Formát: scrypt$N$r$p$sůl$hash; starší hashe scrypt$N$sůl$hash (r=8, p=1) se dál ověří a při přihlášení přepočítají.
const SCRYPT = { N: 2 ** 15, r: 8, p: 3 } as const;
const MAXMEM = 128 * 1024 * 1024;
function scrypt(heslo: string, sul: string, delka: number, volby: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(heslo, sul, delka, volby, (err, klic) => (err ? reject(err) : resolve(klic))),
  );
}

export async function hashujHeslo(heslo: string): Promise<string> {
  const sul = randomBytes(16).toString('hex');
  const hash = await scrypt(heslo, sul, 64, { ...SCRYPT, maxmem: MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sul}$${hash.toString('hex')}`;
}

function rozloz(ulozeno: string): { N: number; r: number; p: number; sul: string; hash: string } | null {
  const c = ulozeno.split('$');
  if (c[0] !== 'scrypt') return null;
  const [n, r, p, sul, hash] = c.length === 4 ? [c[1], '8', '1', c[2], c[3]] : c.slice(1);
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // rozumné meze — poškozený záznam nesmí spustit výpočet na minuty
  if (!sul || !hash || !Number.isInteger(Math.log2(N)) || N < 2 ** 10 || N > 2 ** 20) return null;
  if (!Number.isInteger(R) || R < 1 || R > 32 || !Number.isInteger(P) || P < 1 || P > 16) return null;
  return { N, r: R, p: P, sul, hash };
}

export async function overHeslo(heslo: string, ulozeno: string | null | undefined): Promise<boolean> {
  if (!ulozeno) return false;
  const h = rozloz(ulozeno);
  if (!h) return false;
  const test = await scrypt(heslo, h.sul, 64, { N: h.N, r: h.r, p: h.p, maxmem: MAXMEM });
  const ocekavany = Buffer.from(h.hash, 'hex');
  return ocekavany.length === test.length && timingSafeEqual(ocekavany, test);
}

/** uložený hash má starší (slabší) parametry → po úspěšném přihlášení ho přepočítat */
export function potrebujeRehash(ulozeno: string): boolean {
  const h = rozloz(ulozeno);
  return !h || h.N !== SCRYPT.N || h.r !== SCRYPT.r || h.p !== SCRYPT.p;
}

// Fiktivní hash pro účty bez hesla / neznámý e-mail: ověření trvá stejně dlouho, takže doba odpovědi neprozradí,
// zda e-mail v evidenci je.
let fiktivni: Promise<string> | null = null;
export async function overHesloNaprazdno(heslo: string): Promise<false> {
  fiktivni ??= hashujHeslo(nahodnyToken(16));
  await overHeslo(heslo, await fiktivni);
  return false;
}

/** porovnání tajemství v konstantním čase (délka se prozradit smí) */
export function stejneTajemstvi(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function nahodnyToken(bajtu = 32): string {
  return randomBytes(bajtu).toString('hex');
}

// šestimístný číselný kód (SMS); randomInt je kryptograficky bezpečný
export function nahodnyKod(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hmac(tajemstvi: string, data: string): string {
  return createHmac('sha256', tajemstvi).update(data).digest('hex');
}
