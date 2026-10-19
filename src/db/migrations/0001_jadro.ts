// Jádro: uživatelé, OTP, audit, sezení, OIDC, nastavení. Explicitní SQL — čitelné pro každého, kdo zná Postgres.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE uzivatele (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      telefon text NOT NULL UNIQUE,                 -- E.164 (+420…); telefon je kotva účtu
      email text,                                   -- nepovinný; unikátní bez ohledu na velikost písmen
      heslo_hash text,                              -- nepovinné (přihlášení jde i jen SMS kódem)
      jmeno text NOT NULL DEFAULT '',
      prijmeni text NOT NULL DEFAULT '',
      prezdivka text NOT NULL DEFAULT '',
      cast_obce text NOT NULL DEFAULT '',
      role text[] NOT NULL DEFAULT '{}',            -- občan = prázdné; redaktor | ucetni | spravce | admin
      rezident boolean NOT NULL DEFAULT false,
      gdpr_souhlas_at timestamptz,
      telefon_overen_at timestamptz,
      email_overen_at timestamptz,
      blokovan_at timestamptz,
      vytvoren_at timestamptz NOT NULL DEFAULT now(),
      upraven_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uzivatele_email_idx ON uzivatele (lower(email)) WHERE email IS NOT NULL;

    CREATE TABLE otp_kody (
      id bigserial PRIMARY KEY,
      kontakt text NOT NULL,                        -- normalizovaný telefon nebo e-mail
      ucel text NOT NULL,                           -- prihlaseni | odber | registrace
      kod_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      pouzit_at timestamptz,
      pokusy integer NOT NULL DEFAULT 0,
      vytvoren_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX otp_kody_kontakt_idx ON otp_kody (kontakt, vytvoren_at);

    CREATE TABLE audit_log (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      uzivatel_id uuid,
      akce text NOT NULL,
      detail jsonb,
      ip text
    );
    CREATE INDEX audit_log_uzivatel_idx ON audit_log (uzivatel_id, ts);

    CREATE TABLE sezeni (
      sid text PRIMARY KEY,
      data jsonb NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX sezeni_expires_idx ON sezeni (expires_at);

    CREATE TABLE oidc_payloads (
      id text NOT NULL,
      typ text NOT NULL,
      payload jsonb NOT NULL,
      grant_id text,
      user_code text,
      uid text,
      expires_at timestamptz,
      consumed_at timestamptz,
      PRIMARY KEY (typ, id)
    );
    CREATE INDEX oidc_payloads_grant_idx ON oidc_payloads (grant_id);
    CREATE INDEX oidc_payloads_uid_idx ON oidc_payloads (uid);
    CREATE INDEX oidc_payloads_user_code_idx ON oidc_payloads (user_code);

    CREATE TABLE oidc_klienti (
      client_id text PRIMARY KEY,
      client_secret text NOT NULL,
      nazev text NOT NULL,
      redirect_uris text[] NOT NULL,
      post_logout_redirect_uris text[] NOT NULL DEFAULT '{}',
      duveryhodny boolean NOT NULL DEFAULT false,   -- true = vlastní modul platformy, bez obrazovky souhlasu
      aktivni boolean NOT NULL DEFAULT true,
      vytvoren_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE nastaveni (
      klic text PRIMARY KEY,
      hodnota jsonb NOT NULL,
      upraven_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS nastaveni, oidc_klienti, oidc_payloads, sezeni, audit_log, otp_kody, uzivatele;
  `.execute(db);
}
