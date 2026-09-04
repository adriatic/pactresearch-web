import { createClient } from "@/utils/supabase/server";
import { withRouteErrorHandling } from "@/lib/withRouteErrorHandling";

// "Samples" was cut from pact-web entirely (see 3.13) — not a valid category
// here even though the old pact-mac dialog offered it.
const VALID_CATEGORIES = ["Personal Research", "Dev Test"] as const;

interface CreateNotebookRequestBody {
  name: string;
  category?: string | null;
  systemPrompt?: string | null;
}

async function handlePost(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let name: string;
  let category: string | null | undefined;
  let systemPrompt: string | null | undefined;
  try {
    const body = (await request.json()) as CreateNotebookRequestBody;
    name = body.name;
    category = body.category;
    systemPrompt = body.systemPrompt;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  if (typeof name !== "string" || name.trim().length === 0) {
    return Response.json(
      { error: "name is required and must be a non-empty string." },
      { status: 400 },
    );
  }

  if (
    category != null &&
    !(VALID_CATEGORIES as readonly string[]).includes(category)
  ) {
    return Response.json(
      { error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` },
      { status: 400 },
    );
  }

  const { data: notebook, error } = await supabase
    .from("notebooks")
    .insert({
      user_id: user.id,
      name,
      category: category ?? null,
      system_prompt: systemPrompt ?? null,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return Response.json(notebook, { status: 201 });
}

export const POST = withRouteErrorHandling(handlePost);
