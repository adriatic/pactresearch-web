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
// border + padding box) without a styling fight.
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
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { FileHandler } from "@tiptap/extension-file-handler";
import { useEffect, useRef, useState } from "react";
import type { RichContent } from "@/lib/richContent";
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

function countImageNodes(doc: RichContent): number {
  return (doc.content ?? []).filter((node) => node.type === "image").length;
}

export function Composer({
  discussionId,
  content,
  contentVersion,
  onContentChange,
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
      Image,
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
      {uploadError && <p>{uploadError}</p>}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
