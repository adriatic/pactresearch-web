// Task 91. What to do when no discussion is open: under Task 84's
// "deleted in another tab or window" message, and in the empty
// prompt and response panel. It says how to get a discussion, which
// depends on whether there is a notebook to add one to.
//
// notebookCount is null until the tree's first load has finished; nothing
// is shown then, so "Press New Notebook to start." never flashes up for
// someone who has notebooks.
//
// The names are the ones on screen: the "Add discussion" item and the
// "New Notebook" button. The notebook row's ⋮ button has no name on screen
// and is hard to see, so it is spelled out as "three-dots menu", as in the
// hint under the tree (NotebookCreator.tsx).
export const HINT_WITH_NOTEBOOKS =
  "Pick a discussion in the tree, add a discussion to a notebook (three-dots menu, then Add discussion), or press New Notebook.";
export const HINT_NO_NOTEBOOKS = "Press New Notebook to start.";

export function EmptyStateHint({
  notebookCount,
}: {
  notebookCount: number | null;
}) {
  if (notebookCount === null) return null;
  return (
    <p data-empty-hint>
      {notebookCount > 0 ? HINT_WITH_NOTEBOOKS : HINT_NO_NOTEBOOKS}
    </p>
  );
}
