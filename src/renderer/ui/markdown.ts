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
    const list = /^([-*]|\d+\.)\s/.exec(l);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const el = h(ordered ? "ol" : "ul");
      const item = ordered ? /^\d+\.\s/ : /^[-*]\s/;
      while (i < lines.length && (item.test(lines[i]) || /^\s{2,}\S/.test(lines[i]) || (!lines[i].trim() && /^\s{2,}\S/.test(lines[i + 1] ?? "")))) {
        const line = lines[i++];
        if (item.test(line)) { el.append(h("li", null, inline(line.replace(item, ""), openLink))); continue; }
        if (!line.trim()) continue;
        // indented under the last item: a nested bullet, or more text for it
        const li = el.lastElementChild ?? el.appendChild(h("li"));
        const sub = /^\s+[-*]\s/.exec(line);
        if (sub) {
          const ul = li.lastElementChild?.tagName === "UL" ? li.lastElementChild : li.appendChild(h("ul"));
          ul.append(h("li", null, inline(line.replace(/^\s+[-*]\s/, ""), openLink)));
        } else li.append(h("p", null, inline(line.trim(), openLink)));
      }
      frag.append(el); continue;
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
    while (i < lines.length && lines[i].trim() && !/^(#|[-*]\s|\d+\.\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
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
