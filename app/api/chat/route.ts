import { bearerToken, getCatalog, HttpError } from "@/lib/catalog";
import { chat } from "@/lib/recommend";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const token = bearerToken(req);
    const text = await req.text();
    if (text.length > 200_000) throw new HttpError(413, "För stor förfrågan.");
    let body: any;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      throw new HttpError(400, "Ogiltig JSON.");
    }
    const catalog = await getCatalog(token);
    if (catalog.length === 0) throw new HttpError(502, "Hittade inga publicerade program eller moduler.");
    return Response.json(await chat(catalog, body.turns));
  } catch (err) {
    return errorResponse(err);
  }
}
