import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { ensureDiscussion } from "@/lib/ensureDiscussion";
import { ExecuteTester } from "./ExecuteTester";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const discussionId = await ensureDiscussion(supabase, user.id);

  return <ExecuteTester discussionId={discussionId} />;
}
