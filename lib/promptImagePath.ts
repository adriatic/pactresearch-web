// Single source of truth for the prompt-images proxy URL shape, shared by
// the client-side upload helper (builds it), the Anthropic content-block
// converter (parses it back to a raw storage path), and
// app/api/prompt-images/[...path]/route.ts (serves it) -- so the three
// can't drift apart on the exact prefix string.
//
// A Tiptap image node's `src` is set directly to this proxy URL, not the
// raw storage path -- simpler than the two-layer "store the path,
// translate to a resolvable URL only at render time" design originally
// sketched, since this URL is already a stable, same-origin,
// non-expiring route (not a signed URL with an expiry to manage), so
// there's nothing to translate: the stock @tiptap/extension-image
// renders it as an ordinary <img src> with no customization needed.
export const PROMPT_IMAGE_ROUTE_PREFIX = "/api/prompt-images/";

export function promptImageSrc(storagePath: string): string {
  return `${PROMPT_IMAGE_ROUTE_PREFIX}${storagePath}`;
}

// Returns the raw storage path for a src that points at our own proxy
// route, or null if it doesn't (e.g. some other image src entirely --
// not expected in practice since Composer only ever inserts images
// through uploadPromptImage, but this stays defensive rather than
// assuming every image node was created by this app's own code).
export function storagePathFromPromptImageSrc(src: string): string | null {
  if (!src.startsWith(PROMPT_IMAGE_ROUTE_PREFIX)) return null;
  return src.slice(PROMPT_IMAGE_ROUTE_PREFIX.length);
}
