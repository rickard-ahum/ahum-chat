// Låter Claude matcha användarens beskrivning mot katalogen, i en pågående konversation
// där användaren kan smalna av eller ändra riktning.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { HttpError, type CatalogItem, type Chapter, type Ref } from "./catalog";

const MODEL = "claude-opus-5-5";
const MAX_TURNS = 30;
const MAX_TEXT = 4000;

let client: Anthropic | undefined;

// Läser ANTHROPIC_API_KEY från miljön. Nycklar som inte är knutna till en workspace
// kräver headern anthropic-workspace-id, som då tas från ANTHROPIC_WORKSPACE_ID.
function anthropic() {
  if (!client) {
    const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
    client = new Anthropic(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {});
  }
  return client;
}

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; message: string; recommendationIds: string[] };

export type Recommendation = {
  id: string;
  kind: CatalogItem["kind"];
  name: string;
  description: string;
  reason: string;
  chapterCount: number;
  chapters?: Chapter[];
  modules: Ref[];
  programs: Ref[];
};

export type ChatResult = { message: string; recommendations: Recommendation[] };

const Output = z.object({
  message: z.string(),
  recommendations: z.array(z.object({ id: z.string(), relevance: z.number().int(), reason: z.string() })),
});

const INSTRUCTIONS = `Du hjälper användare av Ahum, en tjänst med digitala KBT-baserade program och moduler, att hitta det innehåll som passar bäst för det de beskriver. Det är ett samtal: användaren kan svara på dina frågor, lägga till detaljer, be om färre eller andra förslag, eller fråga om ett förslag.

Katalogen innehåller två sorters innehåll:
- "program": ett större sammanhållet upplägg som består av flera moduler. Program saknar ofta egen beskrivning; använd då namnet och "modules" (modulerna som ingår) för att förstå vad programmet handlar om.
- "modul": ett mindre avgränsat innehåll. "programs" anger vilka program modulen ingår i.

I varje svar:
- "recommendations": de 1–5 bäst passande posterna just nu, sorterade från mest till minst relevant, med hänsyn till hela samtalet. "relevance" är ett heltal 1–10 för hur väl posten passar (10 = passar mycket väl). Använd bara id:n som finns i katalogen. Varje "reason" är en kort motivering på svenska (1–2 meningar) riktad till användaren ("du"). När användaren smalnar av ska listan bli mer fokuserad, inte bara upprepas. Om användaren bara ställer en fråga om ett tidigare förslag kan du lämna listan tom.
- "message": ett kort svar på svenska (1–3 meningar) till användaren. Hjälp dem att smalna av genom att ställa en konkret följdfråga när det finns flera rimliga vägar, t.ex. om de vill ha ett helt program eller en kortare modul, vilket problem som är mest påtagligt, eller om det gäller dem själva eller deras barn. Ställ högst en fråga åt gången.

Om beskrivningen tyder på akut fara, självmordstankar eller risk för att skada sig själv eller andra: skriv först i "message" att de ska ringa 112 vid akut fara, eller kontakta 1177 Vårdguiden eller Mind Självmordslinjen (90101), och välj ändå det innehåll som kan stötta.`;

// Kompakt katalog för modellen: relationer anges med namn.
function catalogForModel(catalog: CatalogItem[]) {
  return catalog.map((item) => {
    const out: Record<string, unknown> = { id: item.id, kind: item.kind, name: item.name };
    if (item.description) out.description = item.description;
    if (item.long_description) out.long_description = item.long_description;
    if (item.categories.length) out.categories = item.categories;
    if (item.type != null) out.type = item.type;
    if (item.modules?.length) out.modules = item.modules.map((m) => m.name);
    if (item.programs?.length) out.programs = item.programs.map((p) => p.name);
    for (const key of ["duration", "is_treatment", "is_parenting_guide"] as const) {
      if (item[key] != null) out[key] = item[key];
    }
    return out;
  });
}

function validateTurns(input: unknown): Turn[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "Samtalet saknas.");
  const turns: Turn[] = input.slice(-MAX_TURNS).map((t: any) => {
    if (t?.role === "user" && typeof t.text === "string") {
      return { role: "user", text: t.text.trim().slice(0, MAX_TEXT) };
    }
    if (t?.role === "assistant" && typeof t.message === "string") {
      const ids = Array.isArray(t.recommendationIds) ? t.recommendationIds.filter((id: unknown) => typeof id === "string") : [];
      return { role: "assistant", message: t.message.slice(0, MAX_TEXT), recommendationIds: ids };
    }
    throw new HttpError(400, "Ogiltigt samtal.");
  });
  // Samtalet ska börja och sluta med användaren.
  while (turns.length && turns[0].role !== "user") turns.shift();
  const last = turns.at(-1);
  if (!last || last.role !== "user") throw new HttpError(400, "Skriv ett meddelande först.");
  if (turns.length === 1 && last.text.length < 10) {
    throw new HttpError(400, "Beskriv lite mer om vad du vill ha hjälp med.");
  }
  if (!last.text) throw new HttpError(400, "Skriv ett meddelande först.");
  return turns;
}

export async function chat(catalog: CatalogItem[], rawTurns: unknown): Promise<ChatResult> {
  const turns = validateTurns(rawTurns);
  const byId = new Map(catalog.map((item) => [item.id, item]));

  // Slå ihop eventuella på varandra följande turer med samma roll.
  const messages: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    const content =
      t.role === "user"
        ? t.text
        : JSON.stringify({ message: t.message, recommendations: t.recommendationIds.filter((id) => byId.has(id)) });
    const prev = messages.at(-1);
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n\n${content}`;
    else messages.push({ role: t.role, content });
  }

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: zodOutputFormat(Output) },
    system: [
      { type: "text", text: INSTRUCTIONS },
      // Katalogen är densamma mellan förfrågningar, så den cachas.
      { type: "text", text: `Katalog:\n${JSON.stringify(catalogForModel(catalog))}`, cache_control: { type: "ephemeral" } },
    ],
    messages,
  });

  if (response.stop_reason === "refusal") {
    throw new HttpError(422, "Det gick inte att ta fram rekommendationer för det här.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new HttpError(502, "Kunde inte tolka svaret från AI-modellen.");

  // Säkerställ att det mest relevanta kommer först (stabil sortering behåller modellens ordning vid lika).
  const ranked = [...parsed.recommendations].sort((a, b) => b.relevance - a.relevance);
  const seen = new Set<string>();
  const recommendations: Recommendation[] = [];
  for (const r of ranked) {
    const item = byId.get(r.id);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    recommendations.push({
      id: item.id,
      kind: item.kind,
      name: item.name,
      description: item.description,
      reason: r.reason,
      chapterCount: item.chapters?.length ?? item.chapterIds?.length ?? 0,
      chapters: item.chapters,
      modules: item.modules ?? [],
      programs: item.programs ?? [],
    });
  }
  return { message: parsed.message, recommendations };
}
