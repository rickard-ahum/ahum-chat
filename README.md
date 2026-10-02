# Ahum programrekommendationer

En Next.js-app där användaren beskriver vad den vill ha hjälp med och får förslag på
passande program och moduler från Ahum, matchade av Claude. Användaren kan sedan fortsätta
samtalet för att smalna av förslagen.

## Så fungerar det

1. Användaren klistrar in sin token för Ahum-API:t. Servern skickar den som
   `Authorization: Bearer <token>` och hämtar
   `/api/programs/sv?paginate=0` och `/api/modules/sv?paginate=0`.
2. Moduler används bara om `is_published` är sant. Program saknar fältet och tas alltid med.
   Programmens `modules` kopplas ihop med modullistan, så att program visar sina moduler och
   moduler visar vilka program de ingår i. Katalogen cachas i minnet i 10 minuter per token.
   Token sparas aldrig på disk.
3. Användaren beskriver sina problem. Claude (`claude-opus-5-5`) väljer 1–5 poster ur
   katalogen, skriver en kort motivering till varje och ställer ofta en följdfråga. Hela
   samtalet skickas med varje gång, så att användaren kan smalna av. Svar med id:n som inte
   finns i katalogen filtreras bort.

## Kod

- `app/page.tsx` – gränssnittet (token, samtal, kort för program och moduler)
- `app/api/catalog/route.ts` – kontrollerar token och räknar program och moduler
- `app/api/chat/route.ts` – tar emot samtalet och returnerar svar och förslag
- `lib/catalog.ts` – hämtar och kopplar ihop katalogen från Ahum-API:t
- `lib/recommend.ts` – anropet till Claude

## Köra

Kräver Node 20.9 eller senare och en nyckel till Anthropic API i `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_WORKSPACE_ID=wrkspc_...   # bara om nyckeln inte hör till en workspace
```

```sh
npm install
npm run dev        # utveckling, http://localhost:3000
# eller
npm run build && npm start
```

Miljövariabler:

| Variabel | Standard | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (krävs) | Nyckel till Anthropic API |
| `ANTHROPIC_WORKSPACE_ID` | – | Krävs för nycklar som inte hör till en workspace |
| `AHUM_API_BASE` | `https://prod-icbt-api.ahum.se/api` | Bas-URL för Ahum-API:t |
# ahum-recommendations
# ahum-chat
