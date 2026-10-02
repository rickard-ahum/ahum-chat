import { bearerToken, getCatalog, HttpError } from "@/lib/catalog";
import { getChapters } from "@/lib/chapters";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const token = bearerToken(req);
    const { id } = await req.json().catch(() => ({}));
    if (typeof id !== "string") throw new HttpError(400, "Modul saknas.");
    const module = (await getCatalog(token)).find((item) => item.id === id && item.kind === "modul");
    if (!module) throw new HttpError(404, "Hittade inte modulen.");
    return Response.json({ chapters: await getChapters(token, module) });
  } catch (err) {
    return errorResponse(err);
  }
}
