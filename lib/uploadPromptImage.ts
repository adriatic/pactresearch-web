import { createClient } from "@/utils/supabase/client";
import { promptImageSrc } from "./promptImagePath";

// Matches the prompt-images bucket's own allowed_mime_types (the storage
// migration) -- kept in sync by hand since Supabase Storage doesn't
// expose its own bucket config for the client to read at runtime.
const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export class UnsupportedImageTypeError extends Error {}

// Uploads a pasted/dropped image straight from the browser to the private
// prompt-images bucket, using the session's own client (RLS enforces the
// user_id-prefixed path, not a server-side check -- there's no dedicated
// upload API route, since Storage's own INSERT policy already is the real
// enforcement boundary, confirmed directly against production before this
// was built). Returns the same-origin proxy URL (see promptImagePath.ts)
// ready to use directly as a Tiptap image node's src.
export async function uploadPromptImage(
  file: File,
  discussionId: string,
): Promise<{ src: string }> {
  const extension = EXTENSION_BY_MIME_TYPE[file.type];
  if (!extension) {
    throw new UnsupportedImageTypeError(`Unsupported image type: ${file.type}`);
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Not signed in.");
  }

  const path = `${user.id}/${discussionId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from("prompt-images")
    .upload(path, file, { contentType: file.type });

  if (error) {
    throw error;
  }

  return { src: promptImageSrc(path) };
}
