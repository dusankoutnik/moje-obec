// Adresy stránek z názvů: „Obecní úřad – úřední hodiny“ → „obecni-urad-uredni-hodiny“.
export function slugify(s: string, max = 80): string {
  const out = String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'stranka';
}
