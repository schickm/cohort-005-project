// PROTOTYPE — throwaway (issue 17). Triggers sample Notifications for the DevUI user via Knock.
import { data } from "react-router";
import { eq, and } from "drizzle-orm";
import type { Route } from "./+types/api.prototype-notifications-seed";
import { db } from "~/db";
import { teamMembers, TeamMemberRole } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { triggerSamples } from "~/lib/knock.prototype.server";

export async function action({ request }: Route.ActionArgs) {
  if (process.env.NODE_ENV === "production") throw data("Not found", { status: 404 });
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Select a user from the DevUI panel", { status: 401 });
  const isTeamAdmin = !!db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, TeamMemberRole.Admin)))
    .get();
  try {
    return { sent: await triggerSamples(userId, isTeamAdmin) };
  } catch (e) {
    throw data(e instanceof Error ? e.message : String(e), { status: 502 });
  }
}
