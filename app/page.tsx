"use client";

import { useLayoutEffect, useRef, useState } from "react";

type Kind = "program" | "modul";
type Ref = { id: string; name: string };
type Recommendation = {
  id: string;
  kind: Kind;
  name: string;
  description: string;
  reason: string;
  modules: Ref[];
  programs: Ref[];
};
type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; message: string; recommendations: Recommendation[] };

const STARTERS = [
  "Jag sover dåligt och är stressad",
  "Jag har mycket oro och ångest",
  "Jag känner mig nedstämd och orkar inte",
  "Jag vill må bättre i relationen med mitt barn",
];

async function api<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Något gick fel.");
  return data as T;
}

export default function Page() {
  const [token, setToken] = useState("");
  const [catalogInfo, setCatalogInfo] = useState<{ programs: number; modules: number } | null>(null);

  if (!token) {
    return (
      <TokenStep
        onReady={(t, info) => {
          setToken(t);
          setCatalogInfo(info);
        }}
      />
    );
  }
  return (
    <Chat
      token={token}
      catalogInfo={catalogInfo}
      onChangeToken={() => {
        setToken("");
        setCatalogInfo(null);
      }}
    />
  );
}

function TokenStep({ onReady }: { onReady: (token: string, info: { programs: number; modules: number }) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setError("");
    try {
      onReady(t, await api("/api/catalog", t));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="panel token-panel" onSubmit={submit}>
        <h1>Hitta rätt program</h1>
        <p className="muted">Prata med oss om vad du vill ha hjälp med, så föreslår vi program och moduler från Ahum.</p>
        <label htmlFor="token">Token för Ahum-API:t</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          required
          autoFocus
          placeholder="Klistra in din token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Kontrollerar…" : "Fortsätt"}
        </button>
        <p className="muted small">Token sparas inte. Den används bara för att hämta programmen.</p>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

function Chat({
  token,
  catalogInfo,
  onChangeToken,
}: {
  token: string;
  catalogInfo: { programs: number; modules: number } | null;
  onChangeToken: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [lastMinHeight, setLastMinHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastUserRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollOnRender = useRef(false);

  // Rulla en gång när användaren skickar, så att det nya meddelandet hamnar högst upp
  // (som i ChatGPT). När svaret kommer rullas inget, så användaren kan läsa i lugn och ro.
  useLayoutEffect(() => {
    if (!scrollOnRender.current) return;
    scrollOnRender.current = false;
    const container = scrollRef.current;
    const message = lastUserRef.current;
    if (!container || !message) return;
    const top = message.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - 16), behavior: "smooth" });
  }, [turns]);

  // Textrutan växer med innehållet, upp till ungefär sex rader.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    const next: Turn[] = [...turns, { role: "user", text: message }];
    // Den senaste frågan och svaret får minst en skärmhöjd, så att frågan kan ligga högst upp.
    setLastMinHeight(scrollRef.current ? scrollRef.current.clientHeight - 24 : 0);
    scrollOnRender.current = true;
    setTurns(next);
    setDraft("");
    setSending(true);
    setError("");
    try {
      const payload = next.map((t) =>
        t.role === "user"
          ? t
          : { role: "assistant", message: t.message, recommendationIds: t.recommendations.map((r) => r.id) },
      );
      const result = await api<{ message: string; recommendations: Recommendation[] }>("/api/chat", token, {
        turns: payload,
      });
      setTurns([...next, { role: "assistant", ...result }]);
    } catch (err) {
      // Ta bort det obesvarade meddelandet och lägg tillbaka texten så att det går att försöka igen.
      setTurns(turns);
      setDraft(message);
      setError((err as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function newConversation() {
    setTurns([]);
    setDraft("");
    setError("");
    inputRef.current?.focus();
  }

  // Dela upp samtalet i utbyten: en fråga från användaren och svaret på den.
  const exchanges: { user: Extract<Turn, { role: "user" }>; reply?: Extract<Turn, { role: "assistant" }> }[] = [];
  for (const turn of turns) {
    if (turn.role === "user") exchanges.push({ user: turn });
    else if (exchanges.length) exchanges[exchanges.length - 1].reply = turn;
  }
  const empty = exchanges.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            A
          </span>
          Hitta rätt program
        </div>
        <div className="topbar-actions">
          <button type="button" className="ghost" onClick={newConversation} disabled={sending || empty}>
            ＋ Ny<span className="hide-mobile"> konversation</span>
          </button>
          <button type="button" className="link" onClick={onChangeToken} disabled={sending}>
            Byt token
          </button>
        </div>
      </header>

      <div className="scroll" ref={scrollRef}>
        <div className="column">
          {empty ? (
            <div className="empty">
              <h2>Vad vill du ha hjälp med?</h2>
              <p className="muted">
                Berätta med egna ord hur du har det. Jag föreslår program och moduler som passar, och du kan fortsätta
                prata för att hitta rätt.
                {catalogInfo &&
                  ` Just nu finns ${catalogInfo.programs} program och ${catalogInfo.modules} ${catalogInfo.modules === 1 ? "modul" : "moduler"}.`}
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s} type="button" className="starter" onClick={() => send(s)} disabled={sending}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="legend">
                <span>
                  <KindBadge kind="program" /> ett helt upplägg med flera moduler
                </span>
                <span>
                  <KindBadge kind="modul" /> en kortare, avgränsad del
                </span>
              </div>
            </div>
          ) : (
            exchanges.map((ex, i) => {
              const isLast = i === exchanges.length - 1;
              return (
                <section key={i} className="exchange" style={isLast ? { minHeight: lastMinHeight } : undefined}>
                  <div className="msg-user" ref={isLast ? lastUserRef : undefined}>
                    <div className="bubble">{ex.user.text}</div>
                  </div>
                  {ex.reply ? (
                    <AssistantTurn turn={ex.reply} onAsk={send} disabled={sending} />
                  ) : (
                    isLast &&
                    sending && (
                      <div className="msg-assistant">
                        <Avatar />
                        <div className="typing" aria-label="Skriver…">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    )
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            autoFocus
            placeholder={empty ? "Beskriv vad du vill ha hjälp med…" : "Svara eller berätta mer…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(draft);
              }
            }}
            aria-label="Meddelande"
          />
          <button type="submit" className="send" disabled={sending || !draft.trim()} aria-label="Skicka">
            ↑
          </button>
        </form>
        {error ? (
          <p className="error composer-note">{error}</p>
        ) : (
          <p className="muted composer-note">Enter skickar · Shift+Enter ger ny rad · Vid akut fara, ring 112.</p>
        )}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span className="avatar" aria-hidden>
      A
    </span>
  );
}

function AssistantTurn({
  turn,
  onAsk,
  disabled,
}: {
  turn: Extract<Turn, { role: "assistant" }>;
  onAsk: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="msg-assistant">
      <Avatar />
      <div className="assistant-body">
        {turn.message && <p className="assistant-text">{turn.message}</p>}
        {turn.recommendations.length > 0 && (
          <>
            <p className="results-intro">
              Här visar vi de program och moduler som passar dig bäst, med det mest relevanta först.
            </p>
            <div className="cards">
              {turn.recommendations.map((r, rank) => (
                <RecommendationCard key={r.id} rec={r} rank={rank + 1} onAsk={onAsk} disabled={disabled} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: Kind }) {
  return <span className={`badge ${kind}`}>{kind === "program" ? "▣ Program" : "◇ Modul"}</span>;
}

function RecommendationCard({
  rec,
  rank,
  onAsk,
  disabled,
}: {
  rec: Recommendation;
  rank: number;
  onAsk: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <article className={`card ${rec.kind}`}>
      <div className="card-head">
        <span className="rank" aria-label={`Plats ${rank}`}>
          {rank}
        </span>
        <KindBadge kind={rec.kind} />
        {rank === 1 && <span className="best">Mest relevant</span>}
      </div>
      <h3>{rec.name}</h3>
      <p className="reason">{rec.reason}</p>
      {rec.description && <p className="muted">{rec.description}</p>}

      {rec.kind === "modul" && (
        <div className="relation">
          {rec.programs.length ? (
            <>
              <span className="relation-title">Ingår i {rec.programs.length === 1 ? "programmet" : "programmen"}:</span>
              <span className="chips">
                {rec.programs.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="chip"
                    disabled={disabled}
                    title="Fråga om programmet"
                    onClick={() => onAsk(`Berätta mer om programmet "${p.name}". Passar det mig?`)}
                  >
                    ▣ {p.name}
                  </button>
                ))}
              </span>
            </>
          ) : (
            <span className="relation-title">Fristående modul, ingår inte i något program.</span>
          )}
        </div>
      )}

      {rec.kind === "program" && rec.modules.length > 0 && (
        <details className="relation">
          <summary>Innehåller {rec.modules.length} moduler</summary>
          <ul>
            {rec.modules.map((m, i) => (
              <li key={m.id || i}>{m.name}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
