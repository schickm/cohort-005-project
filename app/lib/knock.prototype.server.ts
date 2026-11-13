// PROTOTYPE — throwaway. Answers "What does the Notification Feed look like in Cadence?"
// (https://github.com/schickm/cohort-005-project/issues/17). Not production code.
import { createSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, lessons, modules, users, UserRole } from "~/db/schema";

try {
  process.loadEnvFile();
} catch {
  // .env missing — the feed will show a config error
}

export const PROTOTYPE_WORKFLOW_KEY = "cadence-prototype";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing from .env`);
  return v;
}

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

/** RS256 JWT Knock accepts as X-Knock-User-Token (what @knocklabs/node signUserToken does). */
export function signUserToken(userId: string) {
  const pem = Buffer.from(env("KNOCK_SIGNING_KEY"), "base64").toString("utf8");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(pem).toString("base64url")}`;
}

function trySign(userId: string) {
  try {
    return { userToken: signUserToken(userId), tokenError: null };
  } catch (e) {
    // Only tolerable while Enhanced security mode is off in Knock Development.
    return { userToken: null, tokenError: `User token not signed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function getFeedConfig(userId: number) {
  try {
    return {
      ok: true as const,
      userId: String(userId),
      ...trySign(String(userId)),
      publicKey: env("KNOCK_PUBLIC_API_KEY"),
      channelId: env("KNOCK_FEED_CHANNEL_ID"),
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

export type NotificationKind =
  | "refund_requested"
  | "refund_decided"
  | "enrollment"
  | "seat_claimed"
  | "new_question"
  | "comment_reply"
  | "new_rating"
  | "new_lesson";

type Sample = {
  actor: { id: string; name: string } | null;
  data: { kind: NotificationKind; body: string; url: string; [k: string]: unknown };
};

function userRef(id: number) {
  const u = db.select().from(users).where(eq(users.id, id)).get();
  return u ? { id: String(u.id), name: u.name } : { id: String(id), name: "Someone" };
}

function firstLesson(courseId: number) {
  return db
    .select({ id: lessons.id, title: lessons.title })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .limit(3)
    .all();
}

/** Role-appropriate samples drawn from the v1 catalogue (issue 13), using real seed data. */
export function samplesFor(userId: number, isTeamAdmin: boolean): Sample[] {
  const me = db.select().from(users).where(eq(users.id, userId)).get();
  if (!me) return [];
  const allCourses = db.select().from(courses).all();
  const fallback = allCourses[0];

  if (me.role === UserRole.Admin) {
    const c1 = allCourses[1] ?? fallback;
    const s1 = userRef(6);
    const s2 = userRef(8);
    const lesson = firstLesson(fallback.id)[0];
    return [
      {
        actor: s1,
        data: {
          kind: "refund_requested",
          course: c1.title,
          reason: "The course moved too fast for me.",
          body: `**${s1.name}** requested a refund for **${c1.title}**: "The course moved too fast for me."`,
          url: "/admin/refunds",
        },
      },
      {
        actor: s2,
        data: {
          kind: "refund_requested",
          course: fallback.title,
          reason: "Bought the wrong course.",
          body: `**${s2.name}** requested a refund for **${fallback.title}**: "Bought the wrong course."`,
          url: "/admin/refunds",
        },
      },
      {
        actor: userRef(7),
        data: {
          kind: "comment_reply",
          body: `**${userRef(7).name}** replied to your comment on **${lesson?.title ?? "a lesson"}**`,
          url: `/courses/${fallback.slug}/lessons/${lesson?.id ?? 1}`,
        },
      },
    ];
  }

  if (me.role === UserRole.Instructor) {
    const mine = allCourses.filter((c) => c.instructorId === me.id);
    const c = mine[0] ?? fallback;
    const ls = firstLesson(c.id);
    const a = userRef(5);
    const b = userRef(9);
    const d = userRef(11);
    return [
      {
        actor: a,
        data: { kind: "enrollment", body: `**${a.name}** enrolled in **${c.title}**`, url: `/instructor/${c.id}/students` },
      },
      {
        actor: b,
        data: {
          kind: "new_question",
          body: `New question on **${ls[1]?.title ?? "a lesson"}** from **${b.name}**`,
          excerpt: "Why does the compiler widen this literal to string?",
          url: `/courses/${c.slug}/lessons/${ls[1]?.id ?? 1}`,
        },
      },
      {
        actor: d,
        data: { kind: "new_rating", stars: 4, body: `**${d.name}** rated **${c.title}** ★4`, url: `/instructor/analytics` },
      },
      {
        actor: userRef(12),
        data: { kind: "enrollment", body: `**${userRef(12).name}** enrolled in **${c.title}**`, url: `/instructor/${c.id}/students` },
      },
      {
        actor: a,
        data: {
          kind: "comment_reply",
          body: `**${a.name}** replied to your comment on **${ls[0]?.title ?? "a lesson"}**`,
          url: `/courses/${c.slug}/lessons/${ls[0]?.id ?? 1}`,
        },
      },
    ];
  }

  // Student (maybe also a Team Admin)
  const enrolled = db
    .select({ id: courses.id, slug: courses.slug, title: courses.title, instructorId: courses.instructorId })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.userId, me.id))
    .all();
  const c = enrolled[0] ?? fallback;
  const ls = firstLesson(c.id);
  const instructor = userRef(c.instructorId);
  const out: Sample[] = [
    {
      actor: instructor,
      data: {
        kind: "new_lesson",
        body: `New lesson in **${c.title}**: **${ls[2]?.title ?? "Untitled"}**`,
        url: `/courses/${c.slug}/lessons/${ls[2]?.id ?? 1}`,
      },
    },
    {
      actor: instructor,
      data: {
        kind: "comment_reply",
        body: `**${instructor.name}** replied to your comment on **${ls[0]?.title ?? "a lesson"}**`,
        excerpt: "Good catch — I've fixed the typo in the starter repo.",
        url: `/courses/${c.slug}/lessons/${ls[0]?.id ?? 1}`,
      },
    },
    {
      actor: null,
      data: {
        kind: "refund_decided",
        decision: "declined",
        body: `Your refund request for **${(enrolled[1] ?? fallback).title}** was declined: "Over 30 days since purchase."`,
        url: `/courses/${(enrolled[1] ?? fallback).slug}`,
      },
    },
  ];
  if (isTeamAdmin) {
    const m = userRef(13);
    out.unshift({
      actor: m,
      data: { kind: "seat_claimed", body: `**${m.name}** claimed a seat on **${c.title}** (3 of 5 Seats claimed)`, url: "/team" },
    });
  }
  return out;
}

export async function triggerSamples(userId: number, isTeamAdmin: boolean) {
  const me = userRef(userId);
  const samples = samplesFor(userId, isTeamAdmin);
  for (const s of samples) {
    const res = await fetch(`https://api.knock.app/v1/workflows/${PROTOTYPE_WORKFLOW_KEY}/trigger`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("KNOCK_SECRET_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipients: [me],
        ...(s.actor ? { actor: s.actor } : {}),
        data: s.data,
      }),
    });
    if (!res.ok) throw new Error(`Knock ${res.status}: ${await res.text()}`);
  }
  return samples.length;
}
