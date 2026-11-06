"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  engines,
  failed,
  findEngine,
  needsReplacementGap,
  type DiffEngine,
  type Result,
  type Segment,
  type View,
} from "@/lib/diff/engines";
import {
  answerOptionText,
  compareHref,
  groupHeading,
  tooLongMessage,
  type AnswerGroup,
} from "@/lib/diff/compareAnswers";

// Task D13. The Compare page's screen: two pickers, the two answers'
// prompts, the engine choice and the result. Every color comes from a
// variable in app/globals.css (the .diff-*, .finding-pill-* and
// .diff-count-* classes and the D10 set), so the page follows the
// device's light or dark setting like the rest of the app.

export type CompareSide =
  | { state: "none" }
  | { state: "not-found" }
  | {
      state: "found";
      id: string;
      number: number;
      label: string;
      createdAt: string;
      notebookName: string;
      discussionName: string;
      promptText: string;
      text: string;
    };

type Found = Extract<CompareSide, { state: "found" }>;

const VIEW_NAMES: Record<View, string> = {
  inline: "Inline",
  side: "Side by side",
  findings: "Findings",
};

// Local date and time. The server renders it in its own time zone and
// the browser re-renders it in the user's, so the elements that show it
// carry suppressHydrationWarning.
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Runs the engine. A synchronous engine (all five today) gives its result
// at once; an asynchronous one (a later engine) shows "Comparing…" until
// it settles. A thrown error becomes the engine's error message.
function useComparison(
  engine: DiffEngine,
  a: string,
  b: string,
  blocked: boolean,
): Result | "pending" | null {
  const out = useMemo(() => {
    if (blocked) return null;
    try {
      return engine.compare(a, b);
    } catch (e) {
      return failed(e);
    }
  }, [engine, a, b, blocked]);
  const [settled, setSettled] = useState<{
    from: Promise<Result>;
    result: Result;
  } | null>(null);
  useEffect(() => {
    if (!(out instanceof Promise)) return;
    let live = true;
    out.then(
      (result) => live && setSettled({ from: out, result }),
      (e) => live && setSettled({ from: out, result: failed(e) }),
    );
    return () => {
      live = false;
    };
  }, [out]);
  if (out instanceof Promise) {
    return settled?.from === out ? settled.result : "pending";
  }
  return out;
}

function Picker({
  side,
  groups,
  value,
  notFound,
  onChoose,
}: {
  side: "A" | "B";
  groups: AnswerGroup[];
  value: string;
  notFound: boolean;
  onChoose: (id: string) => void;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <label
        style={{ display: "block", fontWeight: 600, marginBottom: 4 }}
        htmlFor={`compare-pick-${side}`}
      >
        Answer {side}
      </label>
      <select
        id={`compare-pick-${side}`}
        className="toolbar-select"
        value={value}
        onChange={(e) => onChoose(e.target.value)}
        style={{ width: "100%", maxWidth: "100%" }}
      >
        <option value="">Choose an answer…</option>
        {groups.map((group) => (
          <optgroup key={group.discussionId} label={groupHeading(group)}>
            {group.answers.map((answer) => (
              <option
                key={answer.id}
                value={answer.id}
                suppressHydrationWarning
              >
                {answerOptionText(answer, formatWhen)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {notFound && (
        <p
          data-compare-not-found={side}
          style={{ color: "var(--danger)", margin: "6px 0 0" }}
        >
          Response not found
        </p>
      )}
    </div>
  );
}

function SideCard({ side, found }: { side: "A" | "B"; found: Found }) {
  return (
    <section
      aria-label={`Chosen answer ${side}`}
      style={{
        minWidth: 0,
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "10px 12px",
        background: "var(--surface)",
      }}
    >
      <h2 style={{ margin: 0, fontSize: "1rem" }}>
        {side} · answer {found.number}
      </h2>
      <p style={{ margin: "2px 0 8px", color: "var(--text-muted)" }}>
        {found.notebookName} › {found.discussionName}
      </p>
      <p
        style={{
          margin: 0,
          color: "var(--text-muted)",
          fontSize: "0.85em",
        }}
      >
        Prompt
      </p>
      <div
        data-compare-prompt={side}
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          maxHeight: "8.5em",
          overflowY: "auto",
          margin: "2px 0 8px",
        }}
      >
        {found.promptText || "(no prompt text)"}
      </div>
      <p style={{ margin: 0, color: "var(--text-muted)" }}>
        <span data-llm-label>{found.label}</span>
        {" · "}
        <time dateTime={found.createdAt} suppressHydrationWarning>
          {formatWhen(found.createdAt)}
        </time>
      </p>
    </section>
  );
}

function Marked({
  segments,
  keep,
  engine,
}: {
  segments: Segment[];
  keep: (s: Segment) => boolean;
  engine: DiffEngine;
}) {
  const shown = segments.filter(keep);
  return (
    <pre className="diff-text">
      {shown.map((s, i) => (
        <Fragment key={i}>
          <span
            className={
              s.kind === "added"
                ? "diff-added"
                : s.kind === "removed"
                  ? "diff-removed"
                  : undefined
            }
          >
            {s.text}
          </span>
          {needsReplacementGap(engine, s, shown[i + 1]) && " "}
        </Fragment>
      ))}
    </pre>
  );
}

function ResultView({
  engine,
  result,
  view,
  a,
  b,
}: {
  engine: DiffEngine;
  result: Result;
  view: View;
  a: Found;
  b: Found;
}) {
  const name = (side: "A" | "B") =>
    `${side} (answer ${(side === "A" ? a : b).number})`;
  if (result.error) {
    return (
      <div data-compare-error style={{ color: "var(--danger)" }}>
        {result.error.split("\n").map((line) => (
          <p key={line} style={{ margin: "0 0 4px" }}>
            {line.replace(
              /^Input (A|B)\b/,
              (_, k: "A" | "B") => `Answer ${name(k)}`,
            )}
          </p>
        ))}
      </div>
    );
  }
  if (result.segments.length) {
    if (view === "side") {
      return (
        <div
          data-compare-view="side"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            gap: 10,
          }}
        >
          {(["A", "B"] as const).map((side) => (
            <div
              key={side}
              data-compare-panel={side}
              style={{
                minWidth: 0,
                maxHeight: "60vh",
                overflow: "auto",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 10px",
              }}
            >
              <h3
                style={{
                  margin: "0 0 6px",
                  fontSize: "0.9em",
                  color: "var(--text-muted)",
                }}
              >
                {name(side)}
              </h3>
              <Marked
                engine={engine}
                segments={result.segments}
                keep={(s) => s.kind !== (side === "A" ? "added" : "removed")}
              />
            </div>
          ))}
        </div>
      );
    }
    return (
      <div data-compare-view="inline">
        <Marked engine={engine} segments={result.segments} keep={() => true} />
      </div>
    );
  }
  if (result.findings.length) {
    return (
      <div data-compare-view="findings" style={{ display: "grid", gap: 10 }}>
        {result.findings.map((f, i) => (
          <div
            key={i}
            data-compare-finding
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "10px 12px",
              background: "var(--surface)",
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                marginBottom: 8,
              }}
            >
              <strong style={{ overflowWrap: "anywhere" }}>{f.topic}</strong>
              <span className={`finding-pill finding-pill-${f.type}`}>
                {f.type}
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                gap: 8,
              }}
            >
              {(["A", "B"] as const).map((side) => (
                <div
                  key={side}
                  style={{
                    minWidth: 0,
                    background: "var(--button-bg)",
                    borderRadius: 4,
                    padding: "6px 8px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.8em",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                    }}
                  >
                    {name(side)}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {side === "A" ? f.a : f.b}
                  </p>
                </div>
              ))}
            </div>
            <p style={{ margin: "6px 0 0", color: "var(--text-muted)" }}>
              {f.explanation}
            </p>
          </div>
        ))}
      </div>
    );
  }
  return <p data-compare-empty>No differences found.</p>;
}

function Comparison({
  a,
  b,
  engineId,
  onEngine,
}: {
  a: Found;
  b: Found;
  engineId: string;
  onEngine: (id: string) => void;
}) {
  const engine = findEngine(engineId);
  const [chosenView, setView] = useState<View>("inline");
  const view = engine.views.includes(chosenView) ? chosenView : engine.views[0];
  const empty = (["A", "B"] as const).filter(
    (side) => (side === "A" ? a : b).text.trim() === "",
  );
  const tooLong = empty.length
    ? null
    : tooLongMessage(engine.id, a.text, b.text);
  const result = useComparison(
    engine,
    a.text,
    b.text,
    empty.length > 0 || tooLong !== null,
  );
  const tabs = engine.views.filter((v) => v !== "findings");

  return (
    <section aria-label="Comparison" style={{ marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          Engine
          <select
            aria-label="Engine"
            className="toolbar-select"
            value={engine.id}
            onChange={(e) => onEngine(e.target.value)}
          >
            {engines.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
        {tabs.length > 1 && (
          <div
            role="tablist"
            aria-label="View"
            style={{ display: "flex", gap: 6 }}
          >
            {tabs.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                style={
                  view === v
                    ? {
                        background: "var(--selected)",
                        borderColor: "var(--border-strong)",
                        fontWeight: 600,
                      }
                    : undefined
                }
              >
                {VIEW_NAMES[v]}
              </button>
            ))}
          </div>
        )}
        {result && result !== "pending" && !result.error && (
          <p
            data-compare-counts
            style={{ display: "flex", flexWrap: "wrap", gap: 12, margin: 0 }}
          >
            {engine.counts(result).map((c) => (
              <span
                key={c.text}
                className={c.tone ? `diff-count-${c.tone}` : undefined}
                style={c.tone ? undefined : { color: "var(--text-muted)" }}
              >
                {c.text}
              </span>
            ))}
          </p>
        )}
      </div>

      {empty.length > 0 ? (
        <div data-compare-empty-text>
          {empty.map((side) => (
            <p key={side} style={{ margin: "0 0 4px" }}>
              Answer {side} (answer {(side === "A" ? a : b).number}) has no
              text, so there is nothing to compare.
            </p>
          ))}
        </div>
      ) : tooLong ? (
        <p data-compare-too-long>{tooLong}</p>
      ) : result === "pending" ? (
        <p>Comparing…</p>
      ) : result ? (
        <>
          {!result.error && (
            <p
              style={{
                margin: "0 0 10px",
                color: "var(--text-muted)",
                fontSize: "0.9em",
              }}
            >
              {result.summary}
            </p>
          )}
          <ResultView engine={engine} result={result} view={view} a={a} b={b} />
        </>
      ) : null}
    </section>
  );
}

export function CompareView({
  groups,
  a,
  b,
  requested,
  engineId,
}: {
  groups: AnswerGroup[];
  a: CompareSide;
  b: CompareSide;
  requested: { a: string | null; b: string | null };
  engineId: string;
}) {
  const router = useRouter();
  const go = (choice: { a: string | null; b: string | null; engine: string }) =>
    router.push(compareHref(choice), { scroll: false });

  return (
    <main
      style={{
        width: "100%",
        maxWidth: 1200,
        margin: "0 auto",
        padding: "16px 20px 40px",
        boxSizing: "border-box",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Compare answers</h1>
        <Link
          href="/"
          style={{ color: "var(--foreground)", textDecoration: "underline" }}
        >
          Back to the workspace
        </Link>
      </div>

      {groups.length === 0 && (
        <p>
          You have no stored answers yet. Run a prompt in the workspace, then
          come back to compare two answers.
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <Picker
          side="A"
          groups={groups}
          value={a.state === "found" ? a.id : ""}
          notFound={a.state === "not-found"}
          onChoose={(id) =>
            go({ a: id || null, b: requested.b, engine: engineId })
          }
        />
        <Picker
          side="B"
          groups={groups}
          value={b.state === "found" ? b.id : ""}
          notFound={b.state === "not-found"}
          onChoose={(id) =>
            go({ a: requested.a, b: id || null, engine: engineId })
          }
        />
        {a.state === "found" && <SideCard side="A" found={a} />}
        {b.state === "found" && (
          <div style={{ gridColumn: 2, minWidth: 0 }}>
            <SideCard side="B" found={b} />
          </div>
        )}
      </div>

      {a.state === "found" && b.state === "found" ? (
        <Comparison
          a={a}
          b={b}
          engineId={engineId}
          onEngine={(engine) => go({ a: requested.a, b: requested.b, engine })}
        />
      ) : (
        groups.length > 0 && (
          <p style={{ marginTop: 16, color: "var(--text-muted)" }}>
            Choose an answer for A and for B to compare them. Any two answers
            can be compared, also two from the same discussion.
          </p>
        )
      )}
    </main>
  );
}
