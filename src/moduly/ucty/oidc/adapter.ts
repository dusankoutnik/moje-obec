// Adaptér oidc-provider nad Postgresem (Kysely). Jedna tabulka oidc_payloads pro všechny modely
// (Session, Interaction, AuthorizationCode, AccessToken, RefreshToken, Grant, …); klienti v oidc_klienti.
import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Db } from '../../../db/index.js';

export function vytvorAdapter(db: Db) {
  return class KyselyAdapter implements Adapter {
    constructor(private name: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const expires_at = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
      const radek = {
        id,
        typ: this.name,
        payload: JSON.stringify(payload),
        grant_id: payload.grantId ?? null,
        user_code: payload.userCode ?? null,
        uid: payload.uid ?? null,
        expires_at,
      };
      await db
        .insertInto('oidc_payloads')
        .values(radek)
        .onConflict((oc) => oc.columns(['typ', 'id']).doUpdateSet(radek))
        .execute();
    }

    private async nacti(
      where: 'id' | 'uid' | 'user_code',
      hodnota: string,
    ): Promise<AdapterPayload | undefined> {
      if (this.name === 'Client') return this.klient(hodnota);
      const r = await db
        .selectFrom('oidc_payloads')
        .select(['payload', 'expires_at', 'consumed_at'])
        .where('typ', '=', this.name)
        .where(where, '=', hodnota)
        .executeTakeFirst();
      if (!r) return undefined;
      if (r.expires_at && r.expires_at < new Date()) return undefined;
      const p = r.payload as AdapterPayload;
      return { ...p, ...(r.consumed_at ? { consumed: Math.floor(r.consumed_at.getTime() / 1000) } : {}) };
    }

    // klienti z tabulky oidc_klienti → metadata, jak je oidc-provider očekává
    private async klient(clientId: string): Promise<AdapterPayload | undefined> {
      const k = await db
        .selectFrom('oidc_klienti')
        .selectAll()
        .where('client_id', '=', clientId)
        .where('aktivni', '=', true)
        .executeTakeFirst();
      if (!k) return undefined;
      return {
        client_id: k.client_id,
        client_secret: k.client_secret,
        client_name: k.nazev,
        redirect_uris: k.redirect_uris,
        post_logout_redirect_uris: k.post_logout_redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      };
    }

    find(id: string) {
      return this.nacti('id', id);
    }
    findByUid(uid: string) {
      return this.nacti('uid', uid);
    }
    findByUserCode(userCode: string) {
      return this.nacti('user_code', userCode);
    }

    async consume(id: string): Promise<void> {
      await db
        .updateTable('oidc_payloads')
        .set({ consumed_at: new Date() })
        .where('typ', '=', this.name)
        .where('id', '=', id)
        .execute();
    }

    async destroy(id: string): Promise<void> {
      await db.deleteFrom('oidc_payloads').where('typ', '=', this.name).where('id', '=', id).execute();
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await db.deleteFrom('oidc_payloads').where('grant_id', '=', grantId).execute();
    }
  };
}

// úklid prošlých záznamů (cron)
export async function uklidOidc(db: Db): Promise<void> {
  await db.deleteFrom('oidc_payloads').where('expires_at', '<', new Date()).execute();
}
