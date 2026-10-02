import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./catalog";

export function errorResponse(err: unknown) {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof Anthropic.APIError) {
    console.error("Anthropic API error:", err.status, err.message);
    return Response.json({ error: "AI-tjänsten svarade inte som väntat. Försök igen." }, { status: 502 });
  }
  console.error(err);
  return Response.json({ error: "Något gick fel." }, { status: 500 });
}
