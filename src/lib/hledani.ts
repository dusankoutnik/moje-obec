// Fulltext v Postgresu: čeština bez diakritiky (f_unaccent), slova jako prefixy („vyhl“ najde „vyhláška“).
import { sql, type RawBuilder } from 'kysely';

/** z dotazu uživatele udělá tsquery 'slovo:* & slovo2:*'; prázdné → null */
export function tsDotaz(q: string | null | undefined): string | null {
  const slova = String(q ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length >= 2)
    .slice(0, 8);
  // čeština skloňuje: u delších slov hledáme kmen (bez koncovky), aby „uzavírka“ našla i „uzavírce“
  const kmen = (s: string) => (s.length >= 6 ? s.slice(0, -2) : s.length >= 5 ? s.slice(0, -1) : s);
  return slova.length ? slova.map((s) => `${kmen(s)}:*`).join(' & ') : null;
}

/** podmínka „text odpovídá dotazu“ pro výraz s textem (musí sedět s indexem) */
export function odpovida(textSql: RawBuilder<unknown>, dotaz: string) {
  return sql<boolean>`to_tsvector('simple', f_unaccent(lower(${textSql}))) @@ to_tsquery('simple', ${dotaz})`;
}
