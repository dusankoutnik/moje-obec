// Čtení databáze VlastiKanálu (SQLite, jen pro čtení) pro převod — node:sqlite, žádná další závislost.
import { DatabaseSync } from 'node:sqlite';
import type { VkData } from './prevod.js';

export function nactiVlastikanal(cesta: string): VkData {
  const db = new DatabaseSync(cesta, { readOnly: true });
  try {
    const sloupce = (t: string) =>
      new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    const sub = sloupce('subscribers');
    const msg = sloupce('messages');
    const adm = sloupce('admins');
    const sel = (mnozina: Set<string>, s: string, nahrada = 'NULL') =>
      mnozina.has(s) ? s : `${nahrada} AS ${s}`;
    const all = <T>(q: string) => db.prepare(q).all() as unknown as T[];
    return {
      odberatele: all(`SELECT id, name, phone, email, village, token, verified_at, unsubscribed_at, source,
          consent_type, consent_at, note, created_at, ${sel(sub, 'user_id')}, ${sel(sub, 'channel_pref')}
        FROM subscribers ORDER BY id`),
      kategorie: all(`SELECT id, slug, name, optout, sort FROM categories ORDER BY id`),
      optouty: all(`SELECT subscriber_id, category_id FROM optouts`),
      hlaseni:
        all(`SELECT m.id, ${adm.has('user_id') ? 'a.user_id' : 'NULL'} AS author_user_id, m.category_id,
          m.is_crisis, m.target, m.target_detail, m.sms_text, m.email_subject, m.email_body,
          ${sel(msg, 'email_html')}, m.web_title, m.web_body, ${sel(msg, 'web_html')}, m.wp_url, m.status,
          m.scheduled_at, m.created_at, m.finished_at, ${sel(msg, 'auto_source')}
        FROM messages m LEFT JOIN admins a ON a.id = m.author_id ORDER BY m.id`),
      prijemci: all(`SELECT message_id, channel, status, count(*) AS n FROM recipients GROUP BY 1, 2, 3`),
    };
  } finally {
    db.close();
  }
}
