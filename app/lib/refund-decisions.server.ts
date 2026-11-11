import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  coupons,
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import { formatPrice } from "~/lib/utils";
import {
  DECLINE_REASON_MAX,
  DECLINE_REASON_MIN,
  UNDO_WINDOW_MINUTES,
} from "~/lib/refund-decisions";

export { DECLINE_REASON_MAX, DECLINE_REASON_MIN, UNDO_WINDOW_MINUTES };

// ─── Deciding Refund Requests ───
// An Admin can decide any Open Refund Request; an Instructor only those for
// their own courses. Nobody decides a request they raised themselves.
// Whoever decided can undo it for UNDO_WINDOW_MINUTES, after which it's final.
//
// Every function takes the database and the current time, so tests can run
// against an in-memory database at a fixed moment.

type Db = BetterSQLite3Database<typeof schema>;

const UNDO_WINDOW_MS = UNDO_WINDOW_MINUTES * 60 * 1000;


export type Decider = { id: number; role: UserRole };

export type DecisionEmail = { to: string; subject: string; body: string };

export type DecisionResult =
  | { ok: true; email: DecisionEmail }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export function canDecideRefundRequests(role: UserRole) {
  return role === UserRole.Admin || role === UserRole.Instructor;
}

/** Whose requests this person may see and decide, as a where-clause. */
function decidableBy(decider: Decider) {
  const notTheirOwn = ne(purchases.userId, decider.id);
  if (decider.role === UserRole.Admin) return notTheirOwn;
  if (decider.role === UserRole.Instructor) {
    return and(notTheirOwn, eq(courses.instructorId, decider.id));
  }
  // Anyone else matches nothing.
  return sql`0 = 1`;
}

const requestColumns = {
  id: refunds.id,
  status: refunds.status,
  reason: refunds.reason,
  requestedAt: refunds.requestedAt,
  resolvedAt: refunds.resolvedAt,
  resolvedByUserId: refunds.resolvedByUserId,
  declineReason: refunds.declineReason,
  amountRefunded: refunds.amountRefunded,
  purchaseId: purchases.id,
  amountPaid: purchases.amountPaid,
  purchasedAt: purchases.createdAt,
  learnerId: users.id,
  learnerName: users.name,
  learnerEmail: users.email,
  courseId: courses.id,
  courseTitle: courses.title,
  courseSlug: courses.slug,
  courseInstructorId: courses.instructorId,
};

function selectRequests(db: Db) {
  return db
    .select(requestColumns)
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id));
}

type RequestRow = NonNullable<ReturnType<typeof findRequest>>;

export function countOpenRefundRequests(db: Db, decider: Decider): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(and(eq(refunds.status, RefundStatus.Open), decidableBy(decider)))
    .get();
  return row?.count ?? 0;
}

/** Open Refund Requests this person can decide, oldest first. */
export function listOpenRefundRequests(db: Db, decider: Decider, now: Date) {
  const rows = selectRequests(db)
    .where(and(eq(refunds.status, RefundStatus.Open), decidableBy(decider)))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => ({
    ...row,
    daysSincePurchase: wholeDaysBetween(row.purchasedAt, now),
    hoursWatched: hoursWatched(db, row.learnerId, row.courseId),
  }));
}

/** What this person decided recently enough to still undo, newest first. */
export function listUndoableDecisions(db: Db, decider: Decider, now: Date) {
  const cutoff = new Date(now.getTime() - UNDO_WINDOW_MS).toISOString();
  return selectRequests(db)
    .where(
      and(
        ne(refunds.status, RefundStatus.Open),
        eq(refunds.resolvedByUserId, decider.id),
        gt(refunds.resolvedAt, cutoff)
      )
    )
    .orderBy(desc(refunds.resolvedAt))
    .all()
    .map((row) => ({
      ...row,
      undoableUntil: new Date(
        new Date(row.resolvedAt!).getTime() + UNDO_WINDOW_MS
      ).toISOString(),
    }));
}

function findRequest(db: Db, refundId: number) {
  return selectRequests(db).where(eq(refunds.id, refundId)).get();
}

/** Why this person can't decide this request, or null if they can. */
function whyCannotDecide(
  decider: Decider,
  request: RequestRow
): DecisionResult | null {
  if (request.learnerId === decider.id) {
    return {
      ok: false,
      status: 403,
      error: "You can't decide your own refund request.",
    };
  }
  const allowed =
    decider.role === UserRole.Admin ||
    (decider.role === UserRole.Instructor &&
      request.courseInstructorId === decider.id);
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      error: "Only an admin or this course's instructor can decide this.",
    };
  }
  if (request.status !== RefundStatus.Open) {
    return {
      ok: false,
      status: 409,
      error: "This refund request has already been decided.",
    };
  }
  return null;
}

/** A team licence's purchase hands out seats; it never enrolls its buyer. */
function isTeamLicence(db: Db, purchaseId: number) {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
}

export function approveRefundRequest(
  db: Db,
  input: { refundId: number; decider: Decider; now: Date }
): DecisionResult {
  const request = findRequest(db, input.refundId);
  if (!request) {
    return { ok: false, status: 404, error: "Refund request not found." };
  }
  const refusal = whyCannotDecide(input.decider, request);
  if (refusal) return refusal;

  // The learner stops being a Learner on the course. Their progress stays.
  // A refunded team licence's unclaimed seats stop working instead; see
  // isPurchaseRefunded.
  const revokesEnrollment = !isTeamLicence(db, request.purchaseId);

  db.transaction((tx) => {
    let revokedEnrollment: { enrolledAt: string; completedAt: string | null } | null =
      null;
    if (revokesEnrollment) {
      const enrollment = tx
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, request.learnerId),
            eq(enrollments.courseId, request.courseId)
          )
        )
        .get();
      if (enrollment) {
        revokedEnrollment = {
          enrolledAt: enrollment.enrolledAt,
          completedAt: enrollment.completedAt,
        };
        tx.delete(enrollments).where(eq(enrollments.id, enrollment.id)).run();
      }
    }

    tx.update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: request.amountPaid,
        resolvedAt: input.now.toISOString(),
        resolvedByUserId: input.decider.id,
        revokedEnrollment,
      })
      .where(eq(refunds.id, request.id))
      .run();
  });

  return {
    ok: true,
    email: buildDecisionEmail({ ...request, declineReason: null, approved: true }),
  };
}

export function declineRefundRequest(
  db: Db,
  input: { refundId: number; decider: Decider; reason: string; now: Date }
): DecisionResult {
  const reason = input.reason.trim();
  if (reason.length < DECLINE_REASON_MIN) {
    return {
      ok: false,
      status: 400,
      error: "Tell the learner a little more about why you're declining.",
    };
  }
  if (reason.length > DECLINE_REASON_MAX) {
    return {
      ok: false,
      status: 400,
      error: `Please keep the reason under ${DECLINE_REASON_MAX} characters.`,
    };
  }

  const request = findRequest(db, input.refundId);
  if (!request) {
    return { ok: false, status: 404, error: "Refund request not found." };
  }
  const refusal = whyCannotDecide(input.decider, request);
  if (refusal) return refusal;

  db.update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineReason: reason,
      resolvedAt: input.now.toISOString(),
      resolvedByUserId: input.decider.id,
    })
    .where(eq(refunds.id, request.id))
    .run();

  return {
    ok: true,
    email: buildDecisionEmail({ ...request, approved: false, declineReason: reason }),
  };
}

export function undoRefundDecision(
  db: Db,
  input: { refundId: number; decider: Decider; now: Date }
): DecisionResult {
  const request = findRequest(db, input.refundId);
  if (!request) {
    return { ok: false, status: 404, error: "Refund request not found." };
  }
  if (request.status === RefundStatus.Open || !request.resolvedAt) {
    return { ok: false, status: 409, error: "This refund request is still open." };
  }
  if (request.resolvedByUserId !== input.decider.id) {
    return {
      ok: false,
      status: 403,
      error: "Only whoever decided this refund request can undo it.",
    };
  }
  const decidedAt = new Date(request.resolvedAt).getTime();
  if (input.now.getTime() - decidedAt > UNDO_WINDOW_MS) {
    return {
      ok: false,
      status: 409,
      error: `Decisions can only be undone within ${UNDO_WINDOW_MINUTES} minutes.`,
    };
  }

  // Only one Refund Request on a purchase can be open at once.
  const newerRequest = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(eq(refunds.purchaseId, request.purchaseId), gt(refunds.id, request.id))
    )
    .get();
  if (newerRequest) {
    return {
      ok: false,
      status: 409,
      error:
        "The learner has raised a new refund request since, so this decision can't be undone.",
    };
  }

  const stored = db
    .select({ revokedEnrollment: refunds.revokedEnrollment })
    .from(refunds)
    .where(eq(refunds.id, request.id))
    .get();
  const revokedEnrollment = stored?.revokedEnrollment ?? null;

  if (revokedEnrollment) {
    const enrolledAgain = db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.userId, request.learnerId),
          eq(enrollments.courseId, request.courseId)
        )
      )
      .get();
    if (enrolledAgain) {
      return {
        ok: false,
        status: 409,
        error:
          "The learner has enrolled in this course again since, so this approval can't be undone.",
      };
    }
  }

  db.transaction((tx) => {
    if (revokedEnrollment) {
      tx.insert(enrollments)
        .values({
          userId: request.learnerId,
          courseId: request.courseId,
          enrolledAt: revokedEnrollment.enrolledAt,
          completedAt: revokedEnrollment.completedAt,
        })
        .run();
    }
    tx.update(refunds)
      .set({
        status: RefundStatus.Open,
        amountRefunded: null,
        declineReason: null,
        resolvedAt: null,
        resolvedByUserId: null,
        revokedEnrollment: null,
      })
      .where(eq(refunds.id, request.id))
      .run();
  });

  return { ok: true, email: buildDisregardEmail(request) };
}

/** Has this purchase's Refund Request been approved? */
export function isPurchaseRefunded(db: Db, purchaseId: number) {
  return !!db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Approved)
      )
    )
    .get();
}

// ─── Helpers ───

function wholeDaysBetween(fromIso: string, now: Date) {
  const from = new Date(fromIso);
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(now) - startOf(from)) / (24 * 60 * 60 * 1000));
}

/** The furthest point reached in each lesson, summed — as the refund rules count it. */
function hoursWatched(db: Db, userId: number, courseId: number) {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({ furthest: sql<number>`max(${videoWatchEvents.positionSeconds})` })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  const seconds = furthestPerLesson.reduce((sum, row) => sum + row.furthest, 0);
  return Math.round((seconds / 3600) * 10) / 10;
}

// There is no mail transport wired up yet; callers log these.

function buildDecisionEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amountPaid: number;
  approved: boolean;
  declineReason: string | null;
}): DecisionEmail {
  const body = input.approved
    ? [
        `Hi ${input.learnerName},`,
        "",
        `We've approved your refund request for "${input.courseTitle}".`,
        `We're sending back ${formatPrice(input.amountPaid)}, the full amount you paid. You no longer have access to the course.`,
      ]
    : [
        `Hi ${input.learnerName},`,
        "",
        `We've declined your refund request for "${input.courseTitle}". Here's why:`,
        "",
        input.declineReason ?? "",
        "",
        "If something has changed, you're welcome to raise a new refund request.",
      ];

  return {
    to: input.learnerEmail,
    subject: `Refund ${input.approved ? "approved" : "declined"} — ${input.courseTitle}`,
    body: [...body, "", "— The Cadence team"].join("\n"),
  };
}

function buildDisregardEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
}): DecisionEmail {
  return {
    to: input.learnerEmail,
    subject: `Please disregard our last email — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We sent you a decision on your refund request for "${input.courseTitle}" by mistake. Please disregard it.`,
      "Your refund request is still open, and we'll email you again once it's decided.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function logEmail(email: DecisionEmail) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}
