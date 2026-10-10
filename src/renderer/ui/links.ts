// Several links pasted at once (one per line, or separated by spaces or commas): the ones that look like
// links, without duplicates, and whatever else was in the box (so the student can fix it).
export function splitLinks(text: string, already: string[] = []): { links: string[]; rest: string[] } {
  const seen = new Set(already);
  const links: string[] = [], rest: string[] = [];
  for (const part of text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
    let ok = false;
    try { const u = new URL(part); ok = u.protocol === "https:" || u.protocol === "webcal:"; } catch { /* not a link */ }
    if (!ok) { rest.push(part); continue; }
    if (!seen.has(part)) { seen.add(part); links.push(part); }
  }
  return { links, rest };
}
