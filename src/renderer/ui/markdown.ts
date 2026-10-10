// A small Markdown renderer for Duely's own documents (Terms, Privacy): headings, paragraphs, lists,
// tables, **bold**, `code` and [links](url). Builds DOM nodes; never parses HTML.
import { h } from "./h.ts";

export function markdown(md: string, openLink: (url: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = md.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const head = /^(#{1,3})\s+(.*)$/.exec(l);
    if (head) { frag.append(h(`h${head[1].length}` as "h1", null, inline(head[2], openLink))); i++; continue; }
    if (/^\s*[-*]\s/.test(l)) {
      const ul = h("ul");
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) ul.append(h("li", null, inline(lines[i++].replace(/^\s*[-*]\s/, ""), openLink)));
      frag.append(ul); continue;
    }
    if (/^\s*\d+\.\s/.test(l)) {
      const ol = h("ol");
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) ol.append(h("li", null, inline(lines[i++].replace(/^\s*\d+\.\s/, ""), openLink)));
      frag.append(ol); continue;
    }
    if (l.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i++].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      const [head0, ...body] = rows;
      frag.append(h("div", { class: "doc-table" }, h("table", null,
        h("thead", null, h("tr", null, head0.map((c) => h("th", null, inline(c, openLink))))),
        h("tbody", null, body.map((r) => h("tr", null, r.map((c) => h("td", null, inline(c, openLink)))))))));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    frag.append(h("p", null, inline(para.join(" "), openLink)));
  }
  return frag;
}

const TOKEN = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(s: string, openLink: (url: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    frag.append(s.slice(last, m.index));
    if (m[1]) frag.append(h("strong", null, m[1]));
    else if (m[2]) frag.append(h("code", null, m[2]));
    else {
      const url = m[4];
      frag.append(h("a", { href: "#", on: { click: (e) => { e.preventDefault(); openLink(url); } } }, m[3]));
    }
    last = (m.index ?? 0) + m[0].length;
  }
  frag.append(s.slice(last));
  return frag;
}
