// Hämtar en moduls innehåll (kapitel, avsnitt och sidor i modulens ordning) från
// Ahum-API:t via GET /page/treeview-pages/{module_id}/{lang}. Sidorna (och deras frågor)
// används inte, bara kapitel och avsnitt. Det hämtas först när
// användaren fäller ut "Visa kapitel".
import { createHash } from "node:crypto";
import { API_BASE, HttpError, stripHtml, type CatalogItem, type Chapter } from "./catalog";

const LANG = "sv";
const TTL_MS = 10 * 60 * 1000;
const MAX_DESCRIPTION = 240;

const cache = new Map<string, { at: number; chapters: Chapter[] }>(); // sha256(token):modul -> kapitel

type Node = Record<string, any>;

const CHILD_KEYS = ["children", "chapters", "sections", "pages", "items", "nodes", "subpages"];

function nameOf(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as Node;
  for (const key of ["name", "title", "text", "label", "heading"]) {
    if (typeof n[key] === "string" && n[key].trim()) return stripHtml(n[key]);
  }
  // T.ex. { chapter: { name } } eller { section: { title } }
  for (const key of ["chapter", "section", "page"]) {
    if (n[key] && typeof n[key] === "object") {
      const inner = nameOf(n[key]);
      if (inner) return inner;
    }
  }
  return undefined;
}

function descriptionOf(node: Node): string | undefined {
  const text = stripHtml(node.description ?? node.chapter?.description ?? node.short_description);
  if (!text) return undefined;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION).trimEnd()}…` : text;
}

function childrenOf(node: Node): Node[] {
  for (const key of CHILD_KEYS) {
    for (const holder of [node, node.chapter, node.section]) {
      if (holder && Array.isArray(holder[key])) return holder[key].filter((c: unknown) => c && typeof c === "object");
    }
  }
  return [];
}

const isHidden = (node: Node) => node.is_published === false || node.is_published === 0 || node.is_published === "0";

function rootList(body: unknown): Node[] {
  const b = body as Node | undefined;
  for (const v of [b, b?.data, b?.data?.chapters, b?.chapters, b?.data?.children, b?.children, b?.tree, b?.data?.tree]) {
    if (Array.isArray(v)) return v.filter((n) => n && typeof n === "object");
  }
  return [];
}

// Platt lista med typ och förälder, t.ex. [{ id, type: "chapter" }, { type: "section", parent_id }].
function fromFlat(list: Node[]): Chapter[] | undefined {
  const typeOf = (n: Node) => String(n.type ?? n.kind ?? n.node_type ?? "").toLowerCase();
  if (!list.some((n) => typeOf(n).includes("chapter")) || list.some((n) => childrenOf(n).length)) return undefined;
  const parentOf = (n: Node) => String(n.parent_id ?? n.parent ?? n.chapter_id ?? n.section_id ?? "");
  const idOf = (n: Node) => String(n.id ?? n._id ?? "");
  const visible = list.filter((n) => !isHidden(n));
  return visible
    .filter((n) => typeOf(n).includes("chapter"))
    .map((chapter, i) => ({
      id: idOf(chapter) || String(i),
      name: nameOf(chapter) ?? `Kapitel ${i + 1}`,
      description: descriptionOf(chapter),
      sections: visible
        .filter((s) => typeOf(s).includes("section") && parentOf(s) === idOf(chapter))
        .map((s, j) => ({
          name: nameOf(s) ?? `Avsnitt ${j + 1}`,
        })),
    }));
}

// Nästlat träd: kapitel -> avsnitt (-> sidor, som hoppas över).
function fromTree(list: Node[]): Chapter[] {
  return list
    .filter((n) => !isHidden(n))
    .map((chapter, i) => ({
      id: String(chapter.id ?? chapter._id ?? chapter.chapter?.id ?? chapter.chapter?._id ?? i),
      name: nameOf(chapter) ?? `Kapitel ${i + 1}`,
      description: descriptionOf(chapter),
      sections: childrenOf(chapter)
        .filter((s) => !isHidden(s))
        .map((section, j) => ({
          name: nameOf(section) ?? `Avsnitt ${j + 1}`,
        })),
    }));
}

// Loggar svarets form (fältnamn och antal, inget innehåll).
function describe(body: unknown): string {
  const shape = (v: unknown) =>
    Array.isArray(v)
      ? `lista[${v.length}]${v[0] && typeof v[0] === "object" ? ` med fälten ${Object.keys(v[0]).join(", ")}` : ""}`
      : v && typeof v === "object"
        ? `objekt{${Object.keys(v).join(", ")}}`
        : typeof v;
  const root = rootList(body);
  const sections = root[0] ? childrenOf(root[0]) : [];
  return (
    `svar: ${shape(body)}; kapitelnivå: ${shape(root)}` +
    (sections.length ? `; avsnittsnivå: ${shape(sections)}` : "")
  );
}

// Valfritt: kapitlets namn och beskrivning, bara om trädet saknar namn.
async function fillChapterNames(token: string, chapters: Chapter[]) {
  await Promise.all(
    chapters.map(async (chapter, i) => {
      if (!/^Kapitel \d+$/.test(chapter.name) || !chapter.id) return;
      const res = await fetch(`${API_BASE}/chapter/${encodeURIComponent(chapter.id)}/edit/${LANG}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
      }).catch(() => undefined);
      if (!res?.ok) return;
      const body = await res.json().catch(() => undefined);
      const data = (body as Node)?.data ?? body;
      chapters[i] = { ...chapter, name: nameOf(data) ?? chapter.name, description: chapter.description ?? descriptionOf(data ?? {}) };
    }),
  );
}

export async function getChapters(token: string, module: CatalogItem): Promise<Chapter[]> {
  const key = `${createHash("sha256").update(token).digest("hex")}:${module.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.chapters;

  // Prova modulens _id (Mongo-id) före ett numeriskt id.
  const isObjectId = (v: string) => /^[0-9a-f]{24}$/i.test(v);
  const ids = [...(module.apiIds ?? [])].sort((a, b) => Number(isObjectId(b)) - Number(isObjectId(a)));
  let lastStatus = 0;
  for (const moduleId of ids) {
    const url = `${API_BASE}/page/treeview-pages/${encodeURIComponent(moduleId)}/${LANG}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store" });
    } catch (err) {
      throw new HttpError(502, `Kunde inte nå Ahum-API:t: ${(err as Error).message}`);
    }
    if (res.status === 401) throw new HttpError(401, "Ahum-API:t godkände inte token. Kontrollera att den är giltig.");
    if (res.status === 403) throw new HttpError(403, "Din token har inte behörighet att se modulens innehåll (kräver admin eller cc).");
    lastStatus = res.status;
    if (!res.ok) {
      console.log(`[kapitel] /page/treeview-pages/${moduleId}/${LANG} -> ${res.status}`);
      continue;
    }
    const body = await res.json().catch(() => undefined);
    console.log(`[kapitel] /page/treeview-pages/${moduleId}/${LANG} -> ${res.status}; ${describe(body)}`);
    const root = rootList(body);
    const chapters = fromFlat(root) ?? fromTree(root);
    await fillChapterNames(token, chapters);
    console.log(
      `[kapitel] ${chapters.length} kapitel, ` +
        `${chapters.reduce((n, c) => n + (c.sections?.length ?? 0), 0)} avsnitt`,
    );
    cache.set(key, { at: Date.now(), chapters });
    return chapters;
  }
  throw new HttpError(502, `Kunde inte hämta modulens kapitel (Ahum-API:t svarade ${lastStatus}).`);
}
