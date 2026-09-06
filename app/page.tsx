import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { ensureDiscussion } from "@/lib/ensureDiscussion";
import { Workspace } from "./Workspace";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const discussionId = await ensureDiscussion(supabase, user.id);

  return <Workspace initialDiscussionId={discussionId} />;
}
