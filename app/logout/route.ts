import { createClient } from "@/utils/supabase/server";
import { NextResponse } from "next/server";

// GET is the original route (June) and is kept as it was. POST is what
// the Sign out button in the Account window sends (Task 80): 303 so the
// browser follows with a GET to the sign-in page. Only a form on this
// site may post here.
export async function GET(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`);
}

export async function POST(request: Request) {
  const sender = request.headers.get("origin");
  const host = request.headers.get("host");
  if (sender && host && new URL(sender).host !== host) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const supabase = await createClient();
  await supabase.auth.signOut();
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`, 303);
}
