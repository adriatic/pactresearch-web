// Task 84. What every action says when the discussion or notebook it
// names is gone -- most often because it was deleted in another tab or
// window while this one still showed it. The same words are shown by the
// work area when it notices the deletion itself (Workspace.tsx), so a
// refused action and a cleared work area read the same.
//
// The routes answer 404 with these for "not there" in general, which
// also covers another user's id (RLS makes the two indistinguishable,
// deliberately). Only a hand-made request can name another user's id.
export const DISCUSSION_GONE =
  "This discussion was deleted in another tab or window.";
export const NOTEBOOK_GONE =
  "This notebook was deleted in another tab or window.";
