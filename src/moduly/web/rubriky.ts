// Vnořené rubriky aktualit: strom z web_kategorie.nadrazena_id a filtr „rubrika včetně podrubrik“.
import { sql } from 'kysely';

export interface Rubrika {
  id: number;
  slug: string;
  nazev: string;
  poradi: number;
  nadrazena_id: number | null;
}

/** rubrika a všechny její podrubriky (id); ochrana proti cyklu */
export function sPodrubrikami(vse: readonly Rubrika[], id: number): number[] {
  const out = new Set<number>([id]);
  for (let zmena = true; zmena;) {
    zmena = false;
    for (const k of vse)
      if (k.nadrazena_id !== null && out.has(k.nadrazena_id) && !out.has(k.id)) {
        out.add(k.id);
        zmena = true;
      }
  }
  return [...out];
}

/** id rubrik a jejich nadřazených (rubrika s obsahem jen v podrubrice není prázdná) */
export function sNadrazenymi(vse: readonly Rubrika[], ids: Iterable<number>): Set<number> {
  const podleId = new Map(vse.map((k) => [k.id, k]));
  const out = new Set<number>();
  for (let id of ids) {
    while (!out.has(id)) {
      out.add(id);
      const rodic = podleId.get(id)?.nadrazena_id;
      if (rodic == null) break;
      id = rodic;
    }
  }
  return out;
}

/** rubriky ve stromovém pořadí (rodič, pod ním jeho podrubriky podle pořadí a názvu) s úrovní zanoření */
export function stromRubrik<T extends Rubrika>(vse: readonly T[]): (T & { uroven: number })[] {
  const ids = new Set(vse.map((k) => k.id));
  const deti = new Map<number | null, T[]>();
  for (const k of vse) {
    const rodic = k.nadrazena_id !== null && ids.has(k.nadrazena_id) ? k.nadrazena_id : null;
    deti.set(rodic, [...(deti.get(rodic) ?? []), k]);
  }
  const razeni = (a: T, b: T) => a.poradi - b.poradi || a.nazev.localeCompare(b.nazev, 'cs');
  const out: (T & { uroven: number })[] = [];
  const videno = new Set<number>();
  const projdi = (rodic: number | null, uroven: number) => {
    for (const k of [...(deti.get(rodic) ?? [])].sort(razeni)) {
      if (videno.has(k.id)) continue;
      videno.add(k.id);
      out.push({ ...k, uroven });
      projdi(k.id, uroven + 1);
    }
  };
  projdi(null, 0);
  // rubriky v cyklu (nemají kořen) na konec, ať se neztratí
  for (const k of vse) if (!videno.has(k.id)) out.push({ ...k, uroven: 0 });
  return out;
}

/** podmínka „příspěvek je v některé z rubrik“ (hlavní nebo další) pro alias tabulky web_obsah */
export function vRubrikach(ids: readonly number[], alias = 'o') {
  const pole = sql`ARRAY[${sql.join(ids.map((i) => sql`${i}::int`))}]`;
  return sql<boolean>`(${sql.ref(`${alias}.kategorie_id`)} = ANY(${pole}) OR ${sql.ref(`${alias}.kategorie_dalsi`)} && ${pole})`;
}
