// Audit log: kdo, co, kdy — pro úřad i pro dohledání chyb. Nikdy se nemaže.
import type { Db } from '../db/index.js';

export interface AuditZaznam {
  uzivatelId?: string | null;
  akce: string;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

export async function zapisAudit(db: Db, z: AuditZaznam): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      uzivatel_id: z.uzivatelId ?? null,
      akce: z.akce,
      detail: z.detail ? JSON.stringify(z.detail) : null,
      ip: z.ip ?? null,
    })
    .execute();
}
