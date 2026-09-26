"use client";

// The composer's rich-text prompt input, rebuilt on Tiptap/ProseMirror per
// task 28's design proposal + this task's implementation. Two things that
// moved out of the plain-textarea version stay moved out here too:
//
// - The Run button lives in the global header (Workspace.tsx), acting on
//   whatever discussion is selected and whatever content is in its
//   composer. This is the sole run trigger — see the header for why.
//
// - The editor's own sizing is governed entirely by the resizable panel
//   divider in Workspace.tsx, not a native resize affordance — this
//   component's own outer box just fills whatever height it's given and
//   scrolls internally, the same shape the old textarea had.
//
// No Tiptap CSS is imported and no toolbar is rendered — confirmed in the
// task 28 prototype spike that this stays genuinely headless (a plain
// border + padding box) without a styling fight. The one exception is
// the placeholder's own ::before rule (PLACEHOLDER_STYLE below), which
// has no headless alternative: the Placeholder extension only supplies
// the `data-placeholder` attribute and `is-editor-empty` class, leaving
// the actual rendering to CSS by design.
//
// The controlled-value pattern from the old plain textarea (value=/
// onChange=) does NOT carry over directly -- Tiptap's useEditor has no
// value prop; content flows OUT via onUpdate (pushed into
// useDiscussionExecution's own state) and flows IN via an imperative
// editor.commands.setContent() call, guarded by contentVersion (bumped by
// the hook only on a genuine external change -- a discussion switch or a
// post-run clear -- never by this component's own onUpdate round-trip,
// which would otherwise fight the user's live cursor position on every
// keystroke).

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { FileHandler } from "@tiptap/extension-file-handler";
import { Placeholder } from "@tiptap/extension-placeholder";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RichContent } from "@/lib/richContent";
import { registerDiagnosticEditor } from "@/lib/diagnostics";
import {
  uploadPromptImage,
  UnsupportedImageTypeError,
} from "@/lib/uploadPromptImage";

const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

// Task 37 ported pact-mac's own placeholder, which reads "Enter prompt —
// Cmd+V to paste image, Cmd+Enter to send", but had to replace the send
// half with "Run to send": pact-web had no keyboard send shortcut, and
// promising one that does nothing is worse than omitting it.
//
// Task 43 item 1 adds the shortcut, so the original clause is restored --
// it now describes something that actually works. Verified against
// pact-mac's own binding (App.tsx handleKeyDown: Enter + metaKey/ctrlKey
// -> send), so the two apps agree on the combo.
//
// Evaluated as a function rather than a fixed string so it is only ever
// computed when the decoration renders -- i.e. client-side, since the
// editor itself is client-only (immediatelyRender: false). That keeps
// navigator out of the server render path entirely, so this can never
// contribute a hydration mismatch.
function placeholderText(): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  const mod = isApple ? "Cmd" : "Ctrl";
  return `Enter prompt — ${mod}+V to paste image, ${mod}+Enter to send`;
}

// The Placeholder extension renders nothing on its own -- it only adds
// the `data-placeholder` attribute and the `is-editor-empty` class, and
// leaves the display to CSS -- so this rule is the entire visible half of
// the feature, not optional decoration.
//
// Colocated here rather than in app/globals.css deliberately. It only
// ever applies inside this component (the selector is scoped to
// ProseMirror's own generated classes), so globals.css -- which holds
// genuinely app-wide theming: body, buttons -- is the wrong home for it.
// It also keeps the whole feature in one file: the extension, the copy,
// and its rendering.
//
// There is a second, infrastructural reason, recorded because it caused
// a real incident during this task: the first preview built from this
// branch shipped the correct JS but a STALE compiled globals.css, with
// this exact rule silently missing (12,779 deployed bytes vs 12,906
// built locally -- the difference being precisely this rule). Proven to
// be Vercel's build cache: a `vercel deploy --force` of byte-identical
// source, differing only in skipping that cache, emitted 12,934 bytes
// WITH the rule. Shipping it inside the component's own JS chunk, which
// rebuilt correctly throughout, keeps this feature off that path. That
// cache behaviour is a separate problem that still needs attention on
// its own terms -- see this task's status report.
//
// float/height:0 is the documented technique rather than positioning: it
// keeps the placeholder out of layout flow entirely, so the real caret
// still sits at the start of the empty line instead of being pushed
// along by placeholder text occupying the same box.
const PLACEHOLDER_STYLE = `
.tiptap p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  color: #888;
  float: left;
  height: 0;
  pointer-events: none;
}
`;

function countImageNodes(doc: RichContent): number {
  return (doc.content ?? []).filter((node) => node.type === "image").length;
}

export function Composer({
  discussionId,
  content,
  contentVersion,
  onContentChange,
  onSubmit,
  placeholderOverride,
  focusToken,
}: {
  discussionId: string | null;
  content: RichContent;
  // Bumped only when `content` was set from an external source (see the
  // file comment above) -- this component's own sync-in effect below
  // watches this, not `content` itself, to decide when it must call
  // editor.commands.setContent().
  contentVersion: number;
  onContentChange: (
    content: RichContent,
    options?: { saveImmediately?: boolean },
  ) => void;
  // Task 43 item 1. Invoked by the Cmd/Ctrl+Enter keymap below. The
  // composer deliberately does NOT decide whether a run is allowed --
  // Workspace owns that gate, so the shortcut and the Run button can
  // never disagree about it (the same single-source-of-truth argument
  // task 42 part C made for the thinking indicator).
  onSubmit: () => void;
  // Task 49. When set, replaces the standard hint with the follow-up
  // question the user is replying to. Null restores the normal hint.
  placeholderOverride: string | null;
  // Bumped by Workspace to request focus. A counter rather than a
  // boolean so two Continue clicks in a row both focus, and an
  // imperative ref handle is avoided for what is really just "this
  // happened again".
  focusToken: number;
}) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Tracks the doc's own image-node count across updates so onUpdate can
  // tell "this transaction just added an image" (bypass the autosave
  // debounce -- see useDiscussionExecution.ts's own reasoning) from any
  // other kind of edit, without depending on a prop/state value that
  // could be stale inside the onUpdate closure.
  const previousImageCountRef = useRef(countImageNodes(content));
  // discussionId changes without necessarily bumping contentVersion (a
  // freshly-typed image upload needs to target the *current* discussion,
  // not whichever one was active when the editor was constructed) -- kept
  // in its own ref, read inside the FileHandler callbacks below, which
  // close over the editor instance once and don't otherwise re-run per
  // render.
  const discussionIdRef = useRef(discussionId);
  useEffect(() => {
    discussionIdRef.current = discussionId;
  }, [discussionId]);

  // Same ref-indirection reason as discussionIdRef above: useEditor builds
  // its extensions array once, so an extension that closed over `onSubmit`
  // directly would keep calling the first render's copy forever.
  // Read by the Placeholder extension's own callback, which Tiptap
  // holds from the first render -- so the current value has to come
  // from a ref rather than the closed-over prop.
  const placeholderOverrideRef = useRef(placeholderOverride);
  useEffect(() => {
    placeholderOverrideRef.current = placeholderOverride;
  }, [placeholderOverride]);

  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  // Task 43 item 1 -- Cmd+Enter (Ctrl+Enter off Apple) to send.
  //
  // A ProseMirror keymap via Tiptap's addKeyboardShortcuts, deliberately
  // NOT a document- or window-level keydown listener. Task 39's report
  // makes this case explicitly, and it is grounded in a real bug from
  // task 36: an ancestor-level handler intercepting keystrokes before
  // ProseMirror saw them was a genuine, hard-to-diagnose failure in this
  // very composer (a browser extension swallowing Enter -- see the
  // editorProps comment below, which exists because of it). A keymap
  // registered on the editor fires only when the editor has focus and
  // only for the one combo it binds, which is the narrowest scope this
  // can have.
  //
  // "Mod-" is ProseMirror's own platform token: Cmd on Apple, Ctrl
  // elsewhere. Matching pact-mac's `e.metaKey || e.ctrlKey` without
  // hand-rolling the platform check or duplicating the navigator sniff
  // that placeholderText() above needs for display purposes.
  //
  // Returns true unconditionally, so the combo is swallowed even when
  // Workspace's gate declines to run. Letting it fall through would hand
  // Mod-Enter back to ProseMirror's default Enter handling and insert a
  // paragraph break, which is not what someone pressing "send" meant.
  const submitShortcut = useMemo(
    () =>
      Extension.create({
        name: "submitShortcut",
        addKeyboardShortcuts() {
          return {
            "Mod-Enter": () => {
              onSubmitRef.current();
              return true;
            },
          };
        },
      }),
    [],
  );

  async function handleFiles(editor: Editor, files: File[], pos?: number) {
    const targetDiscussionId = discussionIdRef.current;
    if (!targetDiscussionId) {
      setUploadError("Select a discussion before adding an image.");
      return;
    }
    setUploadError(null);
    for (const file of files) {
      try {
        const { src } = await uploadPromptImage(file, targetDiscussionId);
        if (pos !== undefined) {
          editor
            .chain()
            .insertContentAt(pos, {
              type: "image",
              attrs: { src, alt: file.name },
            })
            .focus()
            .run();
        } else {
          editor.chain().focus().setImage({ src, alt: file.name }).run();
        }
      } catch (error) {
        setUploadError(
          error instanceof UnsupportedImageTypeError
            ? error.message
            : "Failed to upload image. Try again.",
        );
      }
    }
  }

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      submitShortcut,
      Image,
      // Same deferred-callback situation as FileHandler below, and the
      // same suppression: this function is called by the Placeholder
      // decoration when the editor renders its empty state, never while
      // this component is rendering, so reading the ref here is reading
      // it at callback time. useEditor also builds this extensions array
      // once, so closing over the prop directly would pin the first
      // render's value forever.
      // eslint-disable-next-line react-hooks/refs
      Placeholder.configure({
        placeholder: () => placeholderOverrideRef.current ?? placeholderText(),
      }),
      // onPaste/onDrop are native DOM event listeners ProseMirror's own
      // plugin system wires up once the view mounts; they only ever fire
      // from a real user paste/drop, strictly after render and commit,
      // never during render itself. handleFiles' read of
      // discussionIdRef.current happens when the callback actually runs
      // (an event handler), not when this config object is constructed --
      // the lint rule's static analysis can't see through
      // FileHandler.configure to know that.
      // eslint-disable-next-line react-hooks/refs
      FileHandler.configure({
        allowedMimeTypes: ALLOWED_IMAGE_MIME_TYPES,
        onPaste: (currentEditor, files) => {
          handleFiles(currentEditor, files);
        },
        onDrop: (currentEditor, files, pos) => {
          handleFiles(currentEditor, files, pos);
        },
      }),
    ],
    content,
    onUpdate: ({ editor: currentEditor }) => {
      const json = currentEditor.getJSON();
      const newImageCount = countImageNodes(json);
      const saveImmediately = newImageCount > previousImageCountRef.current;
      previousImageCountRef.current = newImageCount;
      onContentChange(
        json,
        saveImmediately ? { saveImmediately: true } : undefined,
      );
    },
    editorProps: {
      attributes: {
        "aria-label": "Prompt",
        // Unlike a native <textarea>, a contenteditable div gets no
        // implicit ARIA role/semantics from the browser -- role and
        // aria-multiline have to be added by hand for equivalent
        // accessibility (confirmed missing by default in the task 28
        // prototype spike).
        role: "textbox",
        "aria-multiline": "true",
        // A real, reported bug: a browser extension (Bitwarden, confirmed
        // by directly A/B testing with it disabled -- Enter started
        // working the moment extensions were off, nothing else changed)
        // was intercepting Enter before ProseMirror ever saw it. Chrome's
        // own console flagged this element as an autofill-eligible form
        // field once it has role="textbox" (see "A form field element
        // should have an id or name attribute"), which is almost
        // certainly what invited the interference in the first place.
        // autocomplete="off" plus the Grammarly-specific opt-out
        // attributes below are the standard mitigation for this class of
        // extension interference (password managers, Grammarly, and
        // similar writing-assistant tools all key off similar autofill
        // heuristics) -- confirmed necessary for Enter specifically. Not
        // a fix for anything else: Bold and image paste turned out to
        // have an unrelated cause elsewhere (under active investigation
        // as of this comment, not this attribute), so don't assume this
        // block explains every composer symptom ever reported.
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        spellcheck: "true",
        "data-gramm": "false",
        "data-gramm_editor": "false",
        "data-enable-grammarly": "false",
        style: "outline: none; min-height: 100%;",
      },
    },
  });

  // Task 39: expose this editor instance to the "Report a problem"
  // capture. Tiptap's isEditable/isFocused live on the instance, not in
  // the DOM, so they cannot be read from markup -- and they were exactly
  // what ruled out the "stuck editable flag" theory in task 36. Purely a
  // registration: nothing here reads back into render, so it cannot
  // affect this component's own behaviour, and it clears on unmount so a
  // capture taken with no composer mounted reports `present: false`
  // rather than reading a stale instance.
  useEffect(() => {
    registerDiagnosticEditor(editor ?? null);
    return () => registerDiagnosticEditor(null);
  }, [editor]);

  // The placeholder decoration is only recomputed when the editor's own
  // state changes. Continue clears the composer and sets the hint in the
  // same tick, and an empty editor is otherwise idle, so nudge it with
  // an empty transaction to repaint the new hint.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.view.state.tr);
  }, [editor, placeholderOverride]);

  // Task 49: focus on request. Skips the initial render (focusToken
  // starts at 0) so merely opening a discussion does not steal focus.
  const lastFocusTokenRef = useRef(focusToken);
  useEffect(() => {
    if (!editor) return;
    if (lastFocusTokenRef.current === focusToken) return;
    lastFocusTokenRef.current = focusToken;
    editor.commands.focus("end");
  }, [editor, focusToken]);

  // Sync content IN only on a genuine external change (contentVersion),
  // never on this component's own onUpdate round-trip -- see the file
  // comment above.
  const lastSyncedVersionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!editor) return;
    if (lastSyncedVersionRef.current === contentVersion) return;
    lastSyncedVersionRef.current = contentVersion;
    previousImageCountRef.current = countImageNodes(content);
    editor.commands.setContent(content);
    // content itself is deliberately not a dependency -- this must only
    // re-run when contentVersion changes (a real external update), not on
    // every keystroke's own content change, which would fight the
    // editor's own live cursor position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentVersion, editor]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: 8,
        // Task 28's own approved design proposal specified this exact
        // border ("a plain `border: 1px solid #888` wrapper... renders
        // visually indistinguishable in spirit from today's composer")
        // as the one piece of visible styling this deliberately-headless
        // component keeps -- confirmed present in the design doc, but
        // never actually implemented when task 29 built this component,
        // leaving an empty composer with no visible affordance at all
        // (identical in appearance to blank page background). Reported
        // as "the composer is missing" in production (task 34) --
        // reproduced directly: the editor is fully present and
        // functional the whole time (accepts focus, typing, Run enables
        // correctly), it's simply invisible when there's nothing typed
        // into it yet.
        border: "1px solid #888",
        boxSizing: "border-box",
      }}
    >
      <style>{PLACEHOLDER_STYLE}</style>
      {uploadError && <p>{uploadError}</p>}
      {/* Task 44 item B: 12px of horizontal breathing room so prompt text
          isn't flush against the composer's border. Applied to this
          scroll wrapper rather than to the contenteditable itself, and
          deliberately horizontal-only: the wrapper's height: 100% below
          is load-bearing (see the comment there -- it is what makes the
          whole box focusable rather than just its top line), and adding
          vertical padding here would eat into the definite height that
          chain resolves against. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          paddingLeft: 12,
          paddingRight: 12,
          boxSizing: "border-box",
        }}
      >
        {/* @tiptap/react's EditorContent renders a plain, unstyled div
            around the actual ProseMirror-managed contenteditable (see
            PureEditorContent.render() in node_modules/@tiptap/react/dist/
            index.js -- it just spreads whatever props are passed here
            onto a bare <div>). With no explicit height of its own, that
            wrapper naturally shrinks to its content's own height -- a
            single empty line, ~24px -- rather than filling the space
            this parent's flex:1 already reserves for it. That breaks the
            contenteditable's own `min-height: 100%` (set via
            editorProps.attributes.style above): percentage heights only
            resolve against a parent with a *definite* height, and an
            auto-height parent makes that a no-op. The practical effect,
            confirmed directly (task 36 follow-up): the composer's own
            visible, bordered box is ~140px tall, but only its top ~24px
            -- the single empty line -- was ever actually focusable;
            clicking anywhere else in that visually-identical-looking box
            hit this plain, non-editable wrapper div instead and never
            focused anything. height: "100%" here gives that wrapper a
            real, definite height (resolving cleanly against this
            flex:1 parent, which already has one), so the contenteditable
            inside it can now resolve its own 100% in turn. */}
        <EditorContent editor={editor} style={{ height: "100%" }} />
      </div>
    </div>
  );
}
