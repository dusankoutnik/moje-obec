// Hesla (scrypt z Node — bez nativních závislostí), náhodné tokeny a kódy.
import {
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
  createHmac,
  type ScryptOptions,
} from 'node:crypto';

const SCRYPT: ScryptOptions = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(heslo: string, sul: string, delka: number, volby: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(heslo, sul, delka, volby, (err, klic) => (err ? reject(err) : resolve(klic))),
  );
}

export async function hashujHeslo(heslo: string): Promise<string> {
  const sul = randomBytes(16).toString('hex');
  const hash = await scrypt(heslo, sul, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${sul}$${hash.toString('hex')}`;
}

export async function overHeslo(heslo: string, ulozeno: string | null | undefined): Promise<boolean> {
  if (!ulozeno) return false;
  const [alg, n, sul, hash] = ulozeno.split('$');
  if (alg !== 'scrypt' || !n || !sul || !hash) return false;
  const test = await scrypt(heslo, sul, 64, { ...SCRYPT, N: Number(n) });
  const ocekavany = Buffer.from(hash, 'hex');
  return ocekavany.length === test.length && timingSafeEqual(ocekavany, test);
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
