import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { findLatestDiscussion } from "@/lib/findLatestDiscussion";
import { Workspace } from "./Workspace";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const discussionId = await findLatestDiscussion(supabase, user.id);

  return <Workspace initialDiscussionId={discussionId} />;
}
