import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundStatus, UserRole } from "~/db/schema";
import {
  approveRefundRequest,
  countOpenRefundRequests,
  declineRefundRequest,
  isPurchaseRefunded,
  listOpenRefundRequests,
  listUndoableDecisions,
  undoRefundDecision,
  type Decider,
} from "./refund-decisions.server";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const minutesAfter = (minutes: number) =>
  new Date(NOW.getTime() + minutes * 60 * 1000);
const REASON = "Watched most of it already, which is outside our policy.";

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let admin: Decider;
let owner: Decider;
let otherInstructor: Decider;
let purchaseId: number;
let refundId: number;

function addUser(email: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name: email.split("@")[0], email, role })
    .returning()
    .get();
}

function enrollment() {
  return db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.userId, base.user.id))
    .get();
}

function refund(id = refundId) {
  return db
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.id, id))
    .get()!;
}

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  const adminUser = addUser("admin@example.com", UserRole.Admin);
  const other = addUser("other@example.com", UserRole.Instructor);
  admin = { id: adminUser.id, role: UserRole.Admin };
  owner = { id: base.instructor.id, role: UserRole.Instructor };
  otherInstructor = { id: other.id, role: UserRole.Instructor };

  purchaseId = db
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: "2026-11-08T10:00:00.000Z",
    })
    .returning()
    .get().id;
  db.insert(schema.enrollments)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: "2026-11-08T10:00:00.000Z",
      completedAt: null,
    })
    .run();
  refundId = db
    .insert(schema.refunds)
    .values({
      purchaseId,
      reason: "Bought the wrong course by mistake.",
      requestedAt: "2026-11-09T10:00:00.000Z",
    })
    .returning()
    .get().id;
});

describe("who can see an Open Refund Request", () => {
  it("shows it to an Admin and to the course's Instructor", () => {
    expect(listOpenRefundRequests(db, admin, NOW).map((r) => r.id)).toEqual([
      refundId,
    ]);
    expect(listOpenRefundRequests(db, owner, NOW).map((r) => r.id)).toEqual([
      refundId,
    ]);
    expect(countOpenRefundRequests(db, owner)).toBe(1);
  });

  it("hides it from another course's Instructor and from Students", () => {
    expect(listOpenRefundRequests(db, otherInstructor, NOW)).toEqual([]);
    expect(
      countOpenRefundRequests(db, { id: base.user.id, role: UserRole.Student })
    ).toBe(0);
  });

  it("hides a request from the person who raised it, even an Admin", () => {
    expect(
      listOpenRefundRequests(db, { id: base.user.id, role: UserRole.Admin }, NOW)
    ).toEqual([]);
  });

  it("gives days since purchase and hours watched", () => {
    const mod = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "M", position: 1 })
      .returning()
      .get();
    const lesson = db
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: "L", position: 1 })
      .returning()
      .get();
    db.insert(schema.videoWatchEvents)
      .values([
        { userId: base.user.id, lessonId: lesson.id, eventType: "progress", positionSeconds: 1800 },
        { userId: base.user.id, lessonId: lesson.id, eventType: "progress", positionSeconds: 5400 },
      ])
      .run();

    const [request] = listOpenRefundRequests(db, admin, NOW);
    expect(request.daysSincePurchase).toBe(3);
    expect(request.hoursWatched).toBe(1.5);
  });
});

describe("approving", () => {
  it("refunds the full amount and takes away the enrollment", () => {
    const result = approveRefundRequest(db, { refundId, decider: owner, now: NOW });

    expect(result.ok).toBe(true);
    expect(refund()).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: owner.id,
      resolvedAt: NOW.toISOString(),
    });
    expect(enrollment()).toBeUndefined();
    expect(isPurchaseRefunded(db, purchaseId)).toBe(true);
  });

  it("emails the learner", () => {
    const result = approveRefundRequest(db, { refundId, decider: admin, now: NOW });
    expect(result.ok && result.email).toMatchObject({
      to: "test@example.com",
      subject: "Refund approved — Test Course",
    });
  });

  it("refuses another course's Instructor", () => {
    const result = approveRefundRequest(db, {
      refundId,
      decider: otherInstructor,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(refund().status).toBe(RefundStatus.Open);
  });

  it("refuses someone deciding their own request", () => {
    const result = approveRefundRequest(db, {
      refundId,
      decider: { id: base.user.id, role: UserRole.Admin },
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a request that's already decided", () => {
    approveRefundRequest(db, { refundId, decider: admin, now: NOW });
    const again = declineRefundRequest(db, {
      refundId,
      decider: owner,
      reason: REASON,
      now: NOW,
    });
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it("leaves the buyer's own enrollment alone when refunding a team licence", () => {
    const team = db.insert(schema.teams).values({}).returning().get();
    const teamPurchase = db
      .insert(schema.purchases)
      .values({ userId: base.user.id, courseId: base.course.id, amountPaid: 30000 })
      .returning()
      .get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "SEAT-1",
        purchaseId: teamPurchase.id,
      })
      .run();
    const teamRefund = db
      .insert(schema.refunds)
      .values({ purchaseId: teamPurchase.id, reason: "Team changed its mind." })
      .returning()
      .get();

    approveRefundRequest(db, { refundId: teamRefund.id, decider: admin, now: NOW });

    expect(enrollment()).toBeDefined();
    expect(isPurchaseRefunded(db, teamPurchase.id)).toBe(true);
  });
});

describe("declining", () => {
  it("records the reason and keeps the enrollment", () => {
    const result = declineRefundRequest(db, {
      refundId,
      decider: admin,
      reason: `  ${REASON}  `,
      now: NOW,
    });

    expect(result.ok && result.email.body).toContain(REASON);
    expect(refund()).toMatchObject({
      status: RefundStatus.Declined,
      declineReason: REASON,
      amountRefunded: null,
    });
    expect(enrollment()).toBeDefined();
  });

  it("needs a reason between 10 and 1000 characters", () => {
    for (const reason of ["  too short  ", "x".repeat(1001)]) {
      const result = declineRefundRequest(db, { refundId, decider: admin, reason, now: NOW });
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
    expect(refund().status).toBe(RefundStatus.Open);
  });
});

describe("undoing a decision", () => {
  it("puts an approval back exactly as it was, enrollment included", () => {
    const before = enrollment()!;
    approveRefundRequest(db, { refundId, decider: owner, now: NOW });

    const result = undoRefundDecision(db, {
      refundId,
      decider: owner,
      now: minutesAfter(4),
    });

    expect(result.ok && result.email.subject).toContain("Please disregard");
    expect(refund()).toMatchObject({
      status: RefundStatus.Open,
      amountRefunded: null,
      resolvedAt: null,
      resolvedByUserId: null,
      revokedEnrollment: null,
    });
    expect(enrollment()).toMatchObject({
      enrolledAt: before.enrolledAt,
      completedAt: before.completedAt,
    });
  });

  it("clears a decline's reason", () => {
    declineRefundRequest(db, { refundId, decider: admin, reason: REASON, now: NOW });
    undoRefundDecision(db, { refundId, decider: admin, now: minutesAfter(1) });
    expect(refund()).toMatchObject({ status: RefundStatus.Open, declineReason: null });
  });

  it("is only offered to whoever decided, within five minutes", () => {
    approveRefundRequest(db, { refundId, decider: owner, now: NOW });

    expect(listUndoableDecisions(db, owner, minutesAfter(4)).map((r) => r.id)).toEqual([
      refundId,
    ]);
    expect(listUndoableDecisions(db, admin, minutesAfter(4))).toEqual([]);
    expect(listUndoableDecisions(db, owner, minutesAfter(6))).toEqual([]);

    expect(
      undoRefundDecision(db, { refundId, decider: admin, now: minutesAfter(1) })
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      undoRefundDecision(db, { refundId, decider: owner, now: minutesAfter(6) })
    ).toMatchObject({ ok: false, status: 409 });
    expect(refund().status).toBe(RefundStatus.Approved);
  });

  it("is blocked once the learner has raised a newer request", () => {
    declineRefundRequest(db, { refundId, decider: admin, reason: REASON, now: NOW });
    db.insert(schema.refunds)
      .values({ purchaseId, reason: "Asking again with more detail." })
      .run();

    const result = undoRefundDecision(db, { refundId, decider: admin, now: minutesAfter(1) });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(refund().status).toBe(RefundStatus.Declined);
  });

  it("is blocked once the learner has enrolled again", () => {
    approveRefundRequest(db, { refundId, decider: admin, now: NOW });
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    const result = undoRefundDecision(db, { refundId, decider: admin, now: minutesAfter(1) });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(refund().status).toBe(RefundStatus.Approved);
  });
});
