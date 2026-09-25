import { useEffect, useRef, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import {
  EMPTY_DOC,
  isEmptyDoc,
  plainTextToDoc,
  docToPlainText,
  type RichContent,
} from "@/lib/richContent";

// All of ExecuteTester's state/effects/run(), unchanged, extracted
// into a hook so the fixed-layout shell (Workspace.tsx) can render the
// discussion content and the composer as two separately-positioned
// components — a scrolling middle region and a pinned footer — while both
// share this one live state instance. This is purely a structural split
// for layout purposes; none of the composer's actual behavior changes
// here (that rebuild is 3.13 decision 1's exempted, separately-prototyped
// project, not part of pact-web).
//
// The rich-composer rebuild (task 28's design, this task's
// implementation) changed promptText: string to content: RichContent
// (Tiptap/ProseMirror JSON) throughout -- see the design doc's own
// mapping of every existing behavior onto the new shape. draft-save
// autosave (2000ms debounce + immediate on image insert) is new; the
// save-before-switch ordering and both race-condition guards
// (stale-content misattribution, switch-away-then-back) are unchanged in
// mechanism, now sharing their machinery with autosave rather than only
// firing on switch/run.

export interface PastResponse {
  id: string;
  prompt_text: string;
  prompt_content: RichContent | null;
  response: string | null;
  resolved_model: string | null;
  created_at: string;
}

interface DiscussionRow {
  id: string;
  name: string | null;
  notebook_id: string;
  draft_content: RichContent | null;
  draft_prompt_text: string | null;
}

// How long to wait after the user stops typing before autosaving --
// reuses this app's own already-measured STREAM_WRITE_THROTTLE_MS
// precedent (app/api/execute/route.ts) rather than a fresh guess: long
// enough that normal typing doesn't fire a PATCH on every pause, short
// enough that a crash mid-draft loses at most ~2s of unsaved content.
const AUTOSAVE_DEBOUNCE_MS = 2000;

// Resolves a discussion row's own content for display, without data
// loss for anything that predates the rich-composer rebuild: a real
// draft_content wins outright; otherwise draft_prompt_text (the old
// plain-text column, still populated on pre-rebuild discussions, frozen
// and no longer written once this shipped) is wrapped into a doc rather
// than shown as nothing.
function discussionOwnContent(
  discussion: DiscussionRow | undefined,
): RichContent | null {
  if (!discussion) return null;
  if (discussion.draft_content) return discussion.draft_content;
  if (discussion.draft_prompt_text)
    return plainTextToDoc(discussion.draft_prompt_text);
  return null;
}

// Same fallback, one layer further down, for the "no draft at all -- fall
// back to the last-run cell's own prompt" behavior: a cell's
// prompt_content wins if it has one (a cell created by the rich
// composer), else its plain prompt_text is wrapped the same way.
function lastCellContent(
  lastCell: PastResponse | undefined,
): RichContent | null {
  if (!lastCell) return null;
  if (lastCell.prompt_content) return lastCell.prompt_content;
  if (lastCell.prompt_text) return plainTextToDoc(lastCell.prompt_text);
  return null;
}

export function useDiscussionExecution(discussionId: string | null) {
  const [content, setContentState] = useState<RichContent>(EMPTY_DOC);
  // Bumped only when the hook itself authoritatively sets content from an
  // external source (a discussion finished loading, a run just cleared
  // the draft) -- never by the composer's own typing-driven updates. This
  // is the signal Composer.tsx's own effect watches to know when it must
  // imperatively call editor.commands.setContent() (a discussion switch,
  // or a post-run clear) versus when a `content` change is just its own
  // onUpdate round-tripping back in (which must NOT re-trigger
  // setContent(), or every keystroke would fight the editor's own cursor
  // position).
  const [contentVersion, setContentVersion] = useState(0);
  // Human-readable error text only — never the raw API error payload. Set
  // on a failed run (from /api/execute's { error, errorId } body, or a
  // thrown network error) and cleared at the start of every new run and
  // on discussion switch.
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState<string | null>(null);
  const [streamedModel, setStreamedModel] = useState<string | null>(null);
  const [streamedResponseCreatedAt, setStreamedResponseCreatedAt] = useState<
    string | null
  >(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [history, setHistory] = useState<PastResponse[]>([]);
  // The active discussion's own name, loaded alongside its draft — real
  // persisted data fetched by the same effect below, same reasoning as
  // content/history (see the comment above displayedDiscussionId).
  const [discussionName, setDiscussionName] = useState<string | null>(null);
  // The active discussion's own notebook_id -- loaded the same way, for
  // the same reason. Exposed so Workspace.tsx can target the Settings
  // dialog (per-notebook system prompt) at the right notebook without a
  // second, separately-tracked notion of "which notebook" -- Explorer's
  // own selectedNotebookId only updates on an explicit click and can be
  // stale/null on first load when a discussion arrives pre-selected (via
  // initialDiscussionId), which this can't be: it's set from the same
  // authoritative discussion fetch content/discussionName already rely on.
  const [notebookId, setNotebookId] = useState<string | null>(null);
  // Wall-clock time the most recent switch (or initial load) took, from the
  // moment discussionId changed to the moment content + composer draft were
  // both rendered. Set once, at the end of the effect below — not on every
  // intermediate state update — so it reflects the full round trip.
  const [lastSwitchDurationMs, setLastSwitchDurationMs] = useState<
    number | null
  >(null);

  // Non-persisted live-run display state — cleared immediately, during
  // render, the moment discussionId changes, so a previous discussion's
  // response never flashes next to a different (or absent) active
  // discussion. Adjusted directly during render, same pattern as
  // NotebookCreator's deleted-notebook clear: an effect calling setState
  // synchronously in its body here would trigger an avoidable extra
  // render pass (react-hooks/set-state-in-effect). content and history
  // used to be reset here too (see 4d64d02) — they're real persisted data
  // now (see the effect below), not in-memory state that needs resetting.
  const [displayedDiscussionId, setDisplayedDiscussionId] =
    useState(discussionId);
  if (discussionId !== displayedDiscussionId) {
    setDisplayedDiscussionId(discussionId);
    setExecutionError(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setStreamedResponseCreatedAt(null);
    setIsStreaming(false);
  }

  // Always holds the latest content, readable from the effects below
  // without a stale closure — content changes on every keystroke, but the
  // switch effect only re-runs when discussionId itself changes.
  const contentRef = useRef(content);

  // Which discussion's own content currently, genuinely represents —
  // distinct from activeDiscussionIdRef below, which tracks which
  // discussion is *claimed* as outgoing regardless of whether the user
  // (or its own load) ever actually produced real content for it. Updated
  // below, alongside contentRef, to activeDiscussionIdRef's *current*
  // value every time content actually changes for any reason — the user
  // typing (by far the common case: the composer's onUpdate calls
  // setContent directly, with no connection to saveThenLoad at all) just
  // as much as a load completing or run()'s post-success clear.
  // Deliberately not narrower (e.g. only updated from saveThenLoad's own
  // completion): an earlier version of this fix did that and broke the
  // single most basic case it needed to preserve -- typing a real draft
  // into a discussion whose own background load hadn't technically
  // finished yet still got silently dropped on the next switch, because
  // nothing had ever marked that discussion as the content's genuine
  // owner. What this guards against is the opposite, rarer case:
  // switching through several discussions fast enough that an
  // intermediate one's own load is interrupted *and* the user never typed
  // anything into it either -- then content never changes while it's
  // nominally active, this ref is never touched, and it keeps pointing at
  // whichever discussion's content is still actually displayed. null when
  // content represents nothing real yet (initial mount, or no discussion
  // selected).
  const contentOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    // Guards against React Strict Mode's dev-only mount-time double
    // invocation of this exact effect: it re-runs this body a second
    // time with the *same* closure-captured `content` (no real
    // re-render happened in between), by which point
    // activeDiscussionIdRef.current may have already been advanced by
    // the switch effect below -- re-stamping contentOwnerRef.current
    // from that stale invocation would falsely mark the new discussion
    // as "owning" content the user never actually typed (confirmed
    // directly: it made a genuine, seeded legacy draft get silently
    // skipped on load, with nothing ever typed). Comparing against
    // contentRef.current's own *previous* value (before this line
    // updates it) distinguishes a real content change from a redundant
    // re-invocation of this same effect for the same value.
    const isGenuineChange = contentRef.current !== content;
    contentRef.current = content;
    if (isGenuineChange) {
      contentOwnerRef.current = activeDiscussionIdRef.current;
    }
  }, [content]);

  // Which discussion is currently "claimed" as active by this effect —
  // the outgoing discussion to save the draft against on the next switch.
  // Claimed synchronously at the very start of each effect invocation
  // (inside the effect, before any await — not during render, so this
  // isn't subject to the render-time ref-write restriction), not only
  // after a load fully completes. That distinction matters: if it were
  // only updated on load completion, a second switch that starts before
  // the first one's load has finished would still see the *original*
  // discussion as outgoing, never learning the first switch ever
  // happened — exactly the bug this fixes. null on first mount.
  const activeDiscussionIdRef = useRef<string | null>(null);

  // The most recently fired save request, if it might still be in
  // flight — shared across EVERY save this hook issues, switch-triggered
  // or autosaved, not local to any one trigger. Needed for a real,
  // confirmed race: switch away from a discussion (firing its outgoing
  // save, whichever trigger caused it to be pending), then switch
  // straight back before that save has actually landed. The switch-back's
  // own invocation has nothing new to save (the discussion it's leaving
  // never had its own load validated — see outgoingContentIsValid below),
  // so it always used to proceed straight to reloading the discussion
  // being returned to — racing ahead of the still-in-flight save and
  // reading the *pre-save* draft_content, showing an empty composer even
  // though the save goes on to succeed a moment later. An autosave timer
  // firing right as a switch begins is exactly as much "a save that might
  // still be in flight" as a switch-triggered one — this ref doesn't
  // distinguish, and doesn't need to.
  const pendingSaveRef = useRef<Promise<unknown> | null>(null);

  // The one and only place a PATCH /api/discussions draft-save request is
  // ever issued — called from four places (see saveContent's own call
  // sites below): the switch-away effect, the debounce timer firing, an
  // image-insert detection, and run()'s post-success draft-clear. Not
  // four separate save mechanisms; one, reused, so pendingSaveRef and the
  // ownership guard above only ever have one code path to reason about
  // regardless of what triggered a given save.
  function saveContent(targetDiscussionId: string, targetContent: RichContent) {
    const savePromise = fetch(`/api/discussions?id=${targetDiscussionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draftContent: isEmptyDoc(targetContent) ? null : targetContent,
      }),
    });
    pendingSaveRef.current = savePromise;
    return savePromise;
  }

  // Debounce timer for autosave-while-typing -- owned by, and cleared
  // inside, the same discussionId-keyed effect as everything else here,
  // so switching away before it fires cancels it cleanly (the switch-away
  // path below calls saveContent directly instead) exactly the way the
  // saveThenLoad effect's own `cancelled` flag already prevents a stale
  // in-flight *load* from a previous discussion from applying to a newer
  // one. There is no scenario where a stale timer fires a save against
  // the wrong (already-switched-away-from) discussion.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearAutosaveTimer() {
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }

  // Composer.tsx's own onChange -- called on every real content change
  // (typing, an image inserted). saveImmediately is set by Composer when
  // its own onUpdate transaction detects the doc's image-node count just
  // increased: a pasted/dropped image is a bigger loss than a few words
  // if the tab dies before the debounce timer fires, so it bypasses the
  // debounce entirely rather than merely shortening it.
  function setContent(
    newContent: RichContent,
    options?: { saveImmediately?: boolean },
  ) {
    setContentState(newContent);
    // contentRef/contentOwnerRef are updated by the effect above (keyed on
    // `content`), not here -- this only decides the SAVE side.
    clearAutosaveTimer();
    const targetDiscussionId = activeDiscussionIdRef.current;
    if (!targetDiscussionId) return;

    if (options?.saveImmediately) {
      saveContent(targetDiscussionId, newContent);
    } else {
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null;
        saveContent(targetDiscussionId, newContent);
      }, AUTOSAVE_DEBOUNCE_MS);
    }
  }

  // Single source of truth for both history and the persisted draft:
  // switching discussions saves the outgoing discussion's draft first —
  // awaited, so switching back can't observe a lost save racing against
  // the incoming discussion's load — then loads the new discussion's
  // history and persisted draft. Nothing here is a special-cased
  // in-memory value; it's real data, fetched and saved through the
  // database like everything else in this component.
  useEffect(() => {
    let cancelled = false;
    clearAutosaveTimer();

    async function saveThenLoad() {
      // Captured at the very top, before the outgoing-draft save — the
      // switch is "selected" the instant discussionId changes, and that
      // save is part of the switch's cost, not a separate step.
      const switchStartedAt = performance.now();
      const outgoingDiscussionId = activeDiscussionIdRef.current;
      const outgoingContent = contentRef.current;
      // True only if content's current value genuinely belongs to
      // outgoingDiscussionId (its own completed load, a user keystroke
      // typed while it was active, or its own run() clear) — not
      // leftover from whichever discussion was active before it, which
      // happens when this same discussion is switched away from again
      // before its own saveThenLoad ever got a chance to load its data
      // *and* the user never typed anything into it either. Saving in
      // that case would silently overwrite this discussion's real,
      // correct draft (typically empty/none) with someone else's
      // unrelated content.
      const outgoingContentIsValid =
        contentOwnerRef.current === outgoingDiscussionId;
      activeDiscussionIdRef.current = discussionId;

      // outgoingDiscussionId === discussionId means this invocation isn't
      // a genuine switch — either the very first claim for this target,
      // or React Strict Mode's dev-only second invocation of the same
      // target (the first invocation already claimed it). Only a real
      // mismatch is a genuine outgoing discussion to save.
      if (
        outgoingDiscussionId &&
        outgoingDiscussionId !== discussionId &&
        outgoingContentIsValid
      ) {
        await saveContent(outgoingDiscussionId, outgoingContent);
      } else if (pendingSaveRef.current) {
        // This invocation has nothing of its own to save, but an earlier
        // save (switch-triggered or autosaved) may still be in flight --
        // wait for it before reading anything below. Otherwise a fast
        // switch-away-then-back (this invocation is exactly that:
        // outgoingContentIsValid is false because the discussion being
        // left never had its own load validated) can read stale,
        // pre-save data. Harmless to wait on even when the pending save
        // targets some other discussion entirely -- it's already
        // resolved or resolving regardless, so this never blocks on work
        // that wasn't already happening.
        await pendingSaveRef.current;
      }

      if (cancelled) return;

      if (!discussionId) {
        setContentState(EMPTY_DOC);
        setContentVersion((v) => v + 1);
        contentOwnerRef.current = null;
        setHistory([]);
        setDiscussionName(null);
        setNotebookId(null);
        setLastSwitchDurationMs(performance.now() - switchStartedAt);
        return;
      }

      const [historyBody, discussionsBody] = await Promise.all([
        fetch(`/api/responses?discussionId=${discussionId}`).then((r) =>
          r.json(),
        ),
        fetch(`/api/discussions?id=${discussionId}`).then((r) => r.json()),
      ]);

      if (cancelled) return;

      setHistory(historyBody);
      const loadedDiscussion = (discussionsBody as DiscussionRow[])[0];
      // An actual unsent draft always wins — it may well differ from any
      // cell's prompt (the user started typing something new). Absent
      // one, fall back to the most recently run cell's own content
      // (history is ordered oldest-first, so the last entry is the most
      // recent) rather than leaving the composer blank. Without this, any
      // discussion loaded fresh — a normal switch/reload after a
      // successful run clears the draft by design (see run()'s cleanup
      // below), and an imported discussion never had one to begin with —
      // showed an empty composer despite the exact content sitting right
      // there in its own history. Each layer wraps a legacy plain-text
      // value into a single-paragraph doc via plainTextToDoc rather than
      // assuming every existing row already has structured content.
      const lastCell =
        historyBody.length > 0
          ? (historyBody[historyBody.length - 1] as PastResponse)
          : undefined;
      const resolvedContent =
        discussionOwnContent(loadedDiscussion) ??
        lastCellContent(lastCell) ??
        EMPTY_DOC;
      // Only apply the server's resolved content if the user hasn't
      // already typed something real into *this* discussion since the
      // switch began (contentOwnerRef.current only equals discussionId
      // once a genuine content change has been stamped as belonging to
      // it -- see the content-tracking effect above). Applying
      // resolvedContent unconditionally here would silently overwrite
      // that real, unsent input with whatever the server had -- for any
      // brand-new discussion, the server always has EMPTY_DOC, so the
      // very first thing a user types right after creating a discussion
      // could vanish the moment this load resolves. A real, confirmed
      // race (task 36) -- previously unguarded, unlike the outgoing-save
      // side's own analogous ownership check above.
      // Ownership alone isn't sufficient, though (task 36 follow-up,
      // confirmed with Nik directly): creating a discussion is itself an
      // async POST (NotebookCreator -> onDiscussionCreated ->
      // setActiveDiscussionId), so activeDiscussionIdRef.current can
      // still be null (or the *previous* discussion's id) for whatever
      // gets typed in the brief window before that POST resolves. Those
      // keystrokes get stamped onto the wrong owner, and if this
      // discussion's own (typically very fast, since a brand-new
      // discussion has nothing to fetch) load resolves before any
      // further keystroke corrects it, contentOwnerRef.current still
      // doesn't match discussionId even though real, visible, unsaved
      // text is sitting in the composer right now. The second half of
      // this check closes that gap directly, independent of ownership
      // timing: never discard non-empty live content in favor of an
      // empty resolved value -- there is never a discussion for which
      // showing nothing is better than showing what the user already
      // typed. A resolvedContent that is itself non-empty (an existing
      // discussion with real history/draft) still always wins, matching
      // the existing switch-between-two-real-discussions behavior.
      const alreadyOwnedByThisDiscussion =
        contentOwnerRef.current === discussionId;
      // Task 44 item A. The non-empty-content half of this guard used to
      // have no ownership condition at all, which made it fire for a case
      // it was never meant to cover: switching to a brand-new discussion
      // from one whose own content was on screen. There, contentRef holds
      // the OUTGOING discussion's content (loaded from its last cell, or
      // typed into it and just saved to it by the outgoing-save above),
      // resolvedContent is correctly EMPTY_DOC, and the guard concluded
      // "don't discard real content for nothing" -- so the new
      // discussion opened showing the previous one's prompt, clearable
      // only by hand. Reported by Nik; reproduced in
      // composer-new-discussion-stale-content.spec.ts.
      //
      // `contentOwnerRef.current === null` is what separates the two, and
      // it was verified by instrumenting this exact branch and running
      // all three specs, not reasoned about in the abstract:
      //
      //   composer-new-discussion-typing-race  owner === discussionId
      //   composer-typing-during-discussion-create  owner === null
      //   composer-new-discussion-stale-content (44A)  owner === the
      //     OTHER discussion's id
      //
      // The first is already covered by alreadyOwnedByThisDiscussion, so
      // the second is the only case this half genuinely protects: content
      // typed before ANY discussion had been claimed as active (the
      // creation POST still in flight), which belongs to no discussion at
      // all and would otherwise be lost outright. Task 36's guarantee is
      // therefore preserved exactly -- non-empty content is still never
      // discarded in favour of an empty resolved value when that content
      // is orphaned.
      //
      // When the owner IS another real discussion, the content is not at
      // risk: the outgoing-save above has already written it to that
      // discussion (outgoingContentIsValid is precisely the same
      // ownership test), so clearing the composer here loses nothing and
      // is the correct behaviour for a genuine switch.
      const contentIsOrphaned = contentOwnerRef.current === null;
      const wouldDiscardRealContentForNothing =
        contentIsOrphaned &&
        !isEmptyDoc(contentRef.current) &&
        isEmptyDoc(resolvedContent);
      if (!alreadyOwnedByThisDiscussion && !wouldDiscardRealContentForNothing) {
        setContentState(resolvedContent);
        setContentVersion((v) => v + 1);
      }
      setDiscussionName(loadedDiscussion?.name ?? null);
      setNotebookId(loadedDiscussion?.notebook_id ?? null);
      // This still measures state being set, not paint — React commits the
      // corresponding DOM update in the very next (synchronous, no
      // network/timer in between) render, so it's a close-enough proxy for
      // "content and composer draft fully rendered" without needing a
      // useLayoutEffect/rAF round trip just to time a diagnostic.
      setLastSwitchDurationMs(performance.now() - switchStartedAt);
    }

    saveThenLoad();

    return () => {
      cancelled = true;
      clearAutosaveTimer();
    };
  }, [discussionId]);

  // Takes no event: the Run control lives in the global header
  // (Workspace.tsx), not inside the composer's form, so there is no
  // submit event to preventDefault here.
  async function run() {
    if (!discussionId) return;
    // Fixed for this call — read once, up front, distinct from
    // contentRef.current below, which keeps tracking live edits made
    // while this run is in flight (the composer isn't disabled during a
    // run).
    const submittedContent = content;
    setLoading(true);
    setExecutionError(null);
    setStreamedResponse(null);
    setStreamedModel(null);
    setStreamedResponseCreatedAt(null);
    setIsStreaming(false);

    const supabase = createClient();
    // Which responses row this run is watching — captured from the first
    // INSERT event, so later UPDATE events for some *other* response on
    // this discussion (a future run) don't get applied to this display.
    // This is a best-effort live preview only: /api/execute's own fetch
    // below blocks until the full response is ready and always carries
    // the authoritative final text, so a Realtime hiccup (a dropped
    // event, a subscription that never delivers) can only cost the user
    // the in-progress preview, never the completed response itself.
    let watchedRowId: string | null = null;

    const channel = supabase
      .channel(`responses-${discussionId}-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "responses",
          filter: `discussion_id=eq.${discussionId}`,
        },
        (payload) => {
          if (watchedRowId) return;
          watchedRowId = payload.new.id;
          setStreamedModel(payload.new.resolved_model ?? null);
          setStreamedResponse(payload.new.response ?? "");
          setStreamedResponseCreatedAt(payload.new.created_at ?? null);
          setIsStreaming(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "responses",
          filter: `discussion_id=eq.${discussionId}`,
        },
        (payload) => {
          if (!watchedRowId || payload.new.id !== watchedRowId) return;
          setStreamedResponse(payload.new.response ?? "");
        },
      );

    try {
      // Wait for the subscription to actually be established before
      // firing the POST — otherwise the earliest INSERT (message_start)
      // could land before anything is listening for it.
      await new Promise<void>((resolve, reject) => {
        channel.subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            resolve();
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            reject(err ?? new Error(`Realtime subscription failed: ${status}`));
          }
        });
      });

      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discussionId, promptContent: submittedContent }),
      });
      const body = await response.json();

      if (response.ok) {
        // Authoritative final content, independent of whether the
        // Realtime preview above ever delivered anything.
        setStreamedResponse(body.response ?? "");
        setStreamedModel(body.resolved_model ?? null);
        setStreamedResponseCreatedAt(body.response_created_at ?? null);

        // Reflects the just-completed run directly into history, rather
        // than leaving it visible only via the "Live response" section
        // above (itself overwritten by the *next* run) until some later,
        // unrelated discussion switch happens to refetch it (persistence
        // audit finding A). Guarded on discussionId still matching the
        // currently active one: nothing prevents switching away from
        // this discussion before its own run resolves, and appending to
        // whatever discussion's history is on screen *now* would put
        // this entry under the wrong one. history's own state naturally
        // gets replaced wholesale by the authoritative fetch on the next
        // real load of this discussion (switch or reload), so this is
        // strictly an earlier, same-session view of the same eventual
        // data, never a second, conflicting source of truth for it.
        if (
          body.response_row_id &&
          body.response_created_at &&
          discussionId === activeDiscussionIdRef.current
        ) {
          setHistory((prev) => [
            ...prev,
            {
              id: body.response_row_id,
              prompt_text: docToPlainText(submittedContent),
              prompt_content: submittedContent,
              response: body.response ?? "",
              resolved_model: body.resolved_model ?? null,
              created_at: body.response_created_at,
            },
          ]);
          // Now permanently folded into history -- clear the transient
          // "Live response" display so the same just-completed response
          // isn't rendered a second time right below History showing the
          // identical prompt/response/model/timestamp. Previously this
          // was never cleared here, so it stayed visible until the next
          // run or a discussion switch happened to reset it (see
          // displayedDiscussionId's render-time reset above) -- on the
          // very first run in a fresh discussion, neither of those had
          // happened yet, so the duplicate was visible indefinitely.
          setStreamedResponse(null);
          setStreamedModel(null);
          setStreamedResponseCreatedAt(null);
          setIsStreaming(false);
        }

        // The draft was just promoted into a real cell — clear both its
        // persisted copy (below) and the client-side state itself, the
        // same way, in the same place. Previously only the persisted
        // copy was cleared; the client-side value survived and looked
        // cleared only by accident, because the very next discussion
        // switch's own outgoing-draft save re-persisted that same stale
        // content right back (see 3a02b68's investigation notes) — a
        // passing invariant by coincidence, not by design. Only clears
        // if the composer still holds exactly what was just submitted:
        // if the user has already started typing something new while
        // this run was in flight (the composer isn't disabled during a
        // run), that's real, unsent content and must not be wiped.
        if (contentRef.current === submittedContent) {
          clearAutosaveTimer();
          setContentState(EMPTY_DOC);
          setContentVersion((v) => v + 1);
          if (discussionId) {
            await saveContent(discussionId, EMPTY_DOC).catch(() => {
              // Best-effort: a failure here shouldn't overwrite the
              // run's own result with an unrelated cleanup error.
            });
          }
        }
      } else {
        setExecutionError(
          body.errorId
            ? `${body.error} (error id: ${body.errorId})`
            : body.error,
        );
      }
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setIsStreaming(false);
      await supabase.removeChannel(channel);
    }
  }

  return {
    content,
    contentVersion,
    setContent,
    executionError,
    loading,
    streamedResponse,
    streamedModel,
    streamedResponseCreatedAt,
    isStreaming,
    history,
    run,
    lastSwitchDurationMs,
    discussionName,
    notebookId,
  };
}
