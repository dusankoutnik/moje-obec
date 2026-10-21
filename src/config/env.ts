// Konfigurace z prostředí (.env). Vše tajné je tady; profil obce je v obec.yml.
import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  INTERNAL_BASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Kolik reverzních proxy před aplikací stojí (NPM / Caddy = 1). Víc = podvrhnutelná IP v X-Forwarded-For.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  LOG_LEVEL: z.string().default('info'),
  // vývojová / testovací instalace: X-Robots-Tag noindex na všech odpovědích a robots.txt „Disallow: /“
  ROBOTS_NOINDEX: bool,
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  OIDC_COOKIE_SECRET: z.string().min(32),
  OIDC_PLATFORMA_SECRET: z.string().min(16),
  OBEC_YML: z.string().default('./obec.yml'),
  // Data obce mimo databázi (nahrané soubory, obrázky). V Dockeru pojmenovaný volume — musí přežít rebuild.
  DATA_DIR: z.string().default('./data'),
  SMS_PROVIDER: z.enum(['konzole', 'smsgate', 'smsbrana', 'gosms', 'smsmanager']).default('konzole'),
  SMS_ODESILATEL: z.string().optional(),
  // vývoj/pilot: „+420777000001>+420777000099, …“ — SMS pro tato čísla jdou skutečnou bránou na jiné číslo
  SMS_PRESMEROVANI: z.string().optional(),
  // akce sálu, hřišť a předprodeje z rezervačního systému (JSON /api/kalendar/<token>.json), nepovinné
  REZERVACE_KALENDAR_URL: z.string().url().optional(),
  SMS_PRESMEROVANI_PROVIDER: z
    .enum(['konzole', 'smsgate', 'smsbrana', 'gosms', 'smsmanager'])
    .default('smsgate'),
  SMSGATE_URL: z.string().optional(),
  SMSGATE_USER: z.string().optional(),
  SMSGATE_PASS: z.string().optional(),
  SMSBRANA_LOGIN: z.string().optional(),
  SMSBRANA_PASSWORD: z.string().optional(),
  GOSMS_CLIENT_ID: z.string().optional(),
  GOSMS_CLIENT_SECRET: z.string().optional(),
  GOSMS_CHANNEL: z.string().optional(),
  SMSMANAGER_APIKEY: z.string().optional(),
  // podpis webhooku SMS Manageru (default_callback_secret v jejich administraci); prázdné = podpis se neověřuje
  SMSMANAGER_WEBHOOK_SECRET: z.string().optional(),
  // tajná část adresy webhooku doručenek; prázdné = odvodí se ze SESSION_SECRET (viz docs/INSTALACE.md)
  SMS_WEBHOOK_TOKEN: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.string().min(24).optional()),
  MAIL_PROVIDER: z.enum(['konzole', 'smtp']).default('konzole'),
  MAIL_FROM: z.string().default('Obec <obec@example.cz>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  OTP_DEV_ZOBRAZIT: bool,
  // ochrana SMS s kódy: prodleva mezi kódy na stejné číslo (s), povolené předvolby, denní rozpočet celé instalace
  OTP_COOLDOWN_S: z.coerce.number().int().min(0).default(60),
  SMS_POVOLENE_PREDVOLBY: z.string().default('+420,+421'),
  SMS_DENNI_LIMIT_KODU: z.coerce.number().int().min(0).default(300),
  // kvíz: adresář veřejných balíků otázek (výchozí kviz-otazky/ v repozitáři) a balíky obce mimo repozitář
  // (adresáře oddělené čárkou, např. /app/kviz-instance)
  KVIZ_VEREJNE: z.string().optional(),
  KVIZ_BALIKY: z.string().default(''),
  IK_SMS_INTERVAL_MIN_MS: z.coerce.number().default(1000),
  IK_SMS_INTERVAL_MAX_MS: z.coerce.number().default(3000),
  IK_EMAIL_INTERVAL_MS: z.coerce.number().default(500),
});

export type Env = z.infer<typeof EnvSchema>;

export function nactiEnv(zdroj: NodeJS.ProcessEnv = process.env): Env {
  const vysledek = EnvSchema.safeParse(zdroj);
  if (!vysledek.success) {
    const chyby = vysledek.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Chybná konfigurace prostředí (.env): ${chyby}`);
  }
  const env = vysledek.data;
  // Kód na stránce smí být vidět jen tam, kde se SMS reálně neposílají (konzole) — jinak by se kdokoliv přihlásil za kohokoliv.
  if (env.OTP_DEV_ZOBRAZIT && env.SMS_PROVIDER !== 'konzole') {
    throw new Error('OTP_DEV_ZOBRAZIT=1 je dovoleno jen s SMS_PROVIDER=konzole (testovací instalace).');
  }
  // Ostrá instalace bez SMS brány: kódy by nikomu nepřišly a skončily by jen v logu. Výjimkou je výslovně
  // testovací instalace (OTP_DEV_ZOBRAZIT=1 — kód se ukazuje na stránce).
  if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'konzole' && !env.OTP_DEV_ZOBRAZIT) {
    throw new Error(
      'NODE_ENV=production s SMS_PROVIDER=konzole: SMS by se neposílaly. Nastavte SMS bránu (SMS_PROVIDER), ' +
        'nebo jde-li o testovací instalaci, OTP_DEV_ZOBRAZIT=1.',
    );
  }
  return env;
}
