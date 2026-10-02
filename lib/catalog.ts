// Hämtar program och moduler från Ahum-API:t med användarens token och bygger en katalog
// där program känner till sina moduler och moduler känner till sina program.
import { createHash } from "node:crypto";

export const API_BASE = process.env.AHUM_API_BASE ?? "https://prod-icbt-api.ahum.se/api";
const SOURCES = [
  { kind: "program", url: `${API_BASE}/programs/sv?paginate=0` },
  { kind: "modul", url: `${API_BASE}/modules/sv?paginate=0` },
] as const;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const MAX_LONG_DESCRIPTION = 800;

export type Kind = "program" | "modul";

export type Ref = { id: string; name: string; chapterCount?: number };

export type Section = { name: string; pages: string[] };

export type Chapter = { id: string; name: string; description?: string; sections?: Section[] };

export type CatalogItem = {
  id: string; // "program-<id>" eller "modul-<id>"
  kind: Kind;
  name: string;
  description: string;
  long_description: string;
  categories: unknown[];
  type: unknown;
  apiIds?: string[]; // för moduler: modulens id och _id i Ahum-API:t
  chapterIds?: string[]; // för moduler: id:n i chapter_ids
  chapters?: Chapter[]; // för moduler: kapitel, om API:t redan skickar med namnen
  modules?: Ref[]; // för program: modulerna som ingår
  programs?: Ref[]; // för moduler: programmen modulen ingår i
  duration?: unknown;
  is_treatment?: unknown;
  is_parenting_guide?: unknown;
};

type Raw = Record<string, any> & { _kind: Kind };

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Hjälpfunktioner ---------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function stripHtml(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  return html
    .replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

// API:t svarar med t.ex. { data: [...], status }, men tål även en lista direkt eller djupare nästling.
function extractItems(body: unknown, depth = 0): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && depth !== 3) {
    const obj = body as Record<string, unknown>;
    for (const key of ["data", "programs", "modules", "items", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as any[];
    }
    const firstArray = Object.values(obj).find(Array.isArray);
    if (firstArray) return firstArray as any[];
    for (const value of Object.values(obj)) {
      const nested = extractItems(value, depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}

// Moduler har is_published. Program saknar fältet och räknas då som publicerade.
function isPublished(item: Raw) {
  const v = item.is_published;
  if (v === undefined || v === null) return item._kind === "program";
  return v === true || v === 1 || v === "1" || v === "true";
}

async function fetchSource(source: (typeof SOURCES)[number], token: string): Promise<Raw[]> {
  let res: Response;
  try {
    res = await fetch(source.url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
  } catch (err) {
    throw new HttpError(502, `Kunde inte nå Ahum-API:t (${source.kind}): ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(401, "Ahum-API:t godkände inte token. Kontrollera att den är giltig.");
  }
  if (!res.ok) {
    throw new HttpError(502, `Ahum-API:t svarade ${res.status} för ${source.kind}er.`);
  }
  const items = extractItems(await res.json());
  return items.filter((i) => i && typeof i === "object").map((item) => ({ ...item, _kind: source.kind }));
}

// Ett programs "modules" kan innehålla id:n, _id:n eller objekt; slå upp vilken modul som avses.
function resolveModule(entry: unknown, modulesByAnyId: Map<string, Raw>): Raw | { name: string } | undefined {
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, any>;
    for (const ref of [e.id, e._id, e.module_id, e.module?.id, e.module?._id]) {
      if (ref != null && modulesByAnyId.has(String(ref))) return modulesByAnyId.get(String(ref));
    }
    const name = e.name ?? e.module?.name;
    return typeof name === "string" ? { name } : undefined;
  }
  if (entry != null) return modulesByAnyId.get(String(entry));
  return undefined;
}

export function chapterFrom(c: Record<string, any>): Chapter | undefined {
  const name = c.name ?? c.title ?? c.heading ?? c.label;
  if (typeof name !== "string" || !name.trim()) return undefined;
  return { id: String(c.id ?? c._id ?? name), name: stripHtml(name) };
}

// --- Katalog -----------------------------------------------------------------

const catalogCache = new Map<string, { at: number; items: CatalogItem[] }>(); // sha256(token) -> katalog

export async function getCatalog(token: string): Promise<CatalogItem[]> {
  const key = createHash("sha256").update(token).digest("hex");
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.items;

  const [programsRaw, modulesRaw] = await Promise.all(SOURCES.map((s) => fetchSource(s, token)));

  const modulesByAnyId = new Map<string, Raw>();
  for (const m of modulesRaw) {
    if (m.id != null) modulesByAnyId.set(String(m.id), m);
    if (m._id != null) modulesByAnyId.set(String(m._id), m);
  }

  const items = new Map<string, CatalogItem>();
  const itemFor = new Map<Raw, CatalogItem>();

  for (const raw of [...programsRaw, ...modulesRaw]) {
    if (!isPublished(raw)) continue;
    const rawId = raw.id ?? raw._id;
    if (rawId == null || rawId === "") continue;
    // Program och moduler kan ha samma numeriska id, så typen ingår i nyckeln.
    const id = `${raw._kind}-${rawId}`;
    if (items.has(id)) continue;
    const item: CatalogItem = {
      id,
      kind: raw._kind,
      name: typeof raw.name === "string" ? raw.name : "",
      description: stripHtml(raw.description),
      long_description: truncate(stripHtml(raw.long_description), MAX_LONG_DESCRIPTION),
      categories: Array.isArray(raw.categories) ? raw.categories : [],
      type: raw.type ?? null,
    };
    if (raw._kind === "program") {
      item.modules = [];
      if (raw.duration != null) item.duration = raw.duration;
      if (raw.is_treatment != null) item.is_treatment = raw.is_treatment;
      if (raw.is_parenting_guide != null) item.is_parenting_guide = raw.is_parenting_guide;
    } else {
      item.programs = [];
      item.apiIds = [...new Set([raw.id, raw._id].filter((v) => v != null && v !== "").map(String))];
      const entries: unknown[] = Array.isArray(raw.chapter_ids) ? raw.chapter_ids : Array.isArray(raw.chapters) ? raw.chapters : [];
      item.chapterIds = entries
        .map((c) => (c && typeof c === "object" ? ((c as any).id ?? (c as any)._id) : c))
        .filter((v) => v != null && v !== "")
        .map(String);
      const inline = entries
        .map((c) => (c && typeof c === "object" ? chapterFrom(c as Record<string, any>) : undefined))
        .filter((c): c is Chapter => !!c);
      if (inline.length && inline.length === entries.length) item.chapters = inline;
    }
    items.set(id, item);
    itemFor.set(raw, item);
  }

  // Koppla ihop program och moduler åt båda hållen.
  for (const raw of programsRaw) {
    const program = itemFor.get(raw);
    if (!program || !Array.isArray(raw.modules)) continue;
    for (const entry of raw.modules) {
      const resolved = resolveModule(entry, modulesByAnyId);
      if (!resolved) continue;
      const moduleItem = itemFor.get(resolved as Raw);
      if (moduleItem) {
        if (!program.modules!.some((m) => m.id === moduleItem.id)) {
          program.modules!.push({
            id: moduleItem.id,
            name: moduleItem.name,
            chapterCount: moduleItem.chapters?.length ?? moduleItem.chapterIds?.length ?? 0,
          });
        }
        if (!moduleItem.programs!.some((p) => p.id === program.id)) {
          moduleItem.programs!.push({ id: program.id, name: program.name });
        }
      } else if (!("_kind" in resolved) && resolved.name) {
        // Modulen finns inte i modullistan (t.ex. opublicerad); visa bara namnet.
        program.modules!.push({ id: "", name: resolved.name });
      }
    }
  }

  const list = [...items.values()];
  const programs = list.filter((i) => i.kind === "program");
  const modules = list.filter((i) => i.kind === "modul");
  console.log(
    `[katalog] ${programs.length} program, ${modules.length} moduler; ` +
      `program med moduler: ${programs.filter((p) => p.modules!.length).length}; ` +
      `moduler som ingår i något program: ${modules.filter((m) => m.programs!.length).length}`,
  );

  catalogCache.set(key, { at: Date.now(), items: list });
  return list;
}

export function bearerToken(req: Request): string {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "Ange din token först.");
  // Tål att användaren klistrat in token med "Bearer " framför.
  const token = match[1].trim().replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Ange din token först.");
  return token;
}
