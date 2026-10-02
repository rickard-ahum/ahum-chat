import { bearerToken, getCatalog } from "@/lib/catalog";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const catalog = await getCatalog(bearerToken(req));
    return Response.json({
      programs: catalog.filter((i) => i.kind === "program").length,
      modules: catalog.filter((i) => i.kind === "modul").length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
