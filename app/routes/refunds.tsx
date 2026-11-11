import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/refunds";
import { db } from "~/db";
import { RefundStatus, users } from "~/db/schema";
import { requireUserId } from "~/lib/access.server";
import {
  approveRefundRequest,
  canDecideRefundRequests,
  declineRefundRequest,
  listOpenRefundRequests,
  listUndoableDecisions,
  logEmail,
  undoRefundDecision,
  type Decider,
} from "~/lib/refund-decisions.server";
import { DECLINE_REASON_MAX, DECLINE_REASON_MIN } from "~/lib/refund-decisions";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, CircleCheck, Undo2 } from "lucide-react";

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundId: z.coerce.number().int(),
    reason: z.string(),
  }),
  z.object({
    intent: z.literal("undo"),
    refundId: z.coerce.number().int(),
  }),
]);

async function requireDecider(request: Request): Promise<Decider> {
  const userId = await requireUserId(request);
  const user = db.select().from(users).where(eq(users.id, userId)).get();

  if (!user || !canDecideRefundRequests(user.role)) {
    throw data("Only admins and instructors can decide refund requests.", {
      status: 403,
    });
  }

  return { id: user.id, role: user.role };
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Decide open refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const decider = await requireDecider(request);
  const now = new Date();

  return {
    openRequests: listOpenRefundRequests(db, decider, now),
    undoable: listUndoableDecisions(db, decider, now),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const decider = await requireDecider(request);
  const parsed = parseFormData(await request.formData(), refundDecisionSchema);

  if (!parsed.success) {
    return data({ ok: false as const, error: "Invalid input." }, { status: 400 });
  }

  const input = { refundId: parsed.data.refundId, decider, now: new Date() };
  const result =
    parsed.data.intent === "approve"
      ? approveRefundRequest(db, input)
      : parsed.data.intent === "decline"
        ? declineRefundRequest(db, { ...input, reason: parsed.data.reason })
        : undoRefundDecision(db, input);

  if (!result.ok) {
    return data({ ok: false as const, error: result.error }, { status: result.status });
  }

  logEmail(result.email);

  const message = {
    approve: "Refund request approved.",
    decline: "Refund request declined.",
    undo: "Decision undone. The refund request is open again.",
  }[parsed.data.intent];

  return { ok: true as const, message };
}

type OpenRequest = Route.ComponentProps["loaderData"]["openRequests"][number];
type UndoableDecision = Route.ComponentProps["loaderData"]["undoable"][number];

function useDecisionFetcher() {
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) toast.success(fetcher.data.message);
    else toast.error(fetcher.data.error);
  }, [fetcher.state, fetcher.data]);

  return fetcher;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function OpenRequestCard({ request }: { request: OpenRequest }) {
  const fetcher = useDecisionFetcher();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const busy = fetcher.state !== "idle";
  const trimmedLength = reason.trim().length;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              to={`/courses/${request.courseSlug}`}
              className="font-semibold hover:underline"
            >
              {request.courseTitle}
            </Link>
            <p className="text-sm text-muted-foreground">
              {request.learnerName} · {request.learnerEmail}
            </p>
          </div>
          <span className="text-lg font-semibold">
            {formatPrice(request.amountPaid)}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Bought</dt>
            <dd>{formatDate(request.purchasedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Asked</dt>
            <dd>{formatDate(request.requestedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Days since purchase</dt>
            <dd>{request.daysSincePurchase}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Hours watched</dt>
            <dd>{request.hoursWatched}</dd>
          </div>
        </dl>

        <blockquote className="border-l-2 pl-3 text-sm">{request.reason}</blockquote>

        {declining ? (
          <fetcher.Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="decline" />
            <input type="hidden" name="refundId" value={request.id} />
            <label htmlFor={`reason-${request.id}`} className="text-sm font-medium">
              Why are you declining? The learner will see this.
            </label>
            <Textarea
              id={`reason-${request.id}`}
              name="reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={DECLINE_REASON_MAX}
              rows={3}
              autoFocus
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {trimmedLength < DECLINE_REASON_MIN
                  ? `At least ${DECLINE_REASON_MIN} characters.`
                  : `${trimmedLength}/${DECLINE_REASON_MAX}`}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDeclining(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={busy || trimmedLength < DECLINE_REASON_MIN}
                >
                  Decline
                </Button>
              </div>
            </div>
          </fetcher.Form>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeclining(true)} disabled={busy}>
              Decline…
            </Button>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="approve" />
              <input type="hidden" name="refundId" value={request.id} />
              <Button type="submit" disabled={busy}>
                Approve {formatPrice(request.amountPaid)} refund
              </Button>
            </fetcher.Form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UndoableDecisionRow({ decision }: { decision: UndoableDecision }) {
  const fetcher = useDecisionFetcher();
  const approved = decision.status === RefundStatus.Approved;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <p className="text-sm">
          <span
            className={
              approved
                ? "mr-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300"
                : "mr-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300"
            }
          >
            {approved ? "Approved" : "Declined"}
          </span>
          <span className="font-medium">{decision.learnerName}</span> ·{" "}
          {decision.courseTitle} · {formatPrice(decision.amountPaid)}
        </p>
        {decision.declineReason && (
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {decision.declineReason}
          </p>
        )}
      </div>
      <fetcher.Form method="post" className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Until {formatTime(decision.undoableUntil)}
        </span>
        <input type="hidden" name="intent" value="undo" />
        <input type="hidden" name="refundId" value={decision.id} />
        <Button type="submit" size="sm" variant="outline" disabled={fetcher.state !== "idle"}>
          <Undo2 className="size-4" />
          Undo
        </Button>
      </fetcher.Form>
    </div>
  );
}

/** Re-renders periodically so undo buttons disappear when their window closes. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function RefundRequests({ loaderData }: Route.ComponentProps) {
  const { openRequests } = loaderData;
  const now = useNow(10_000);
  const undoable = loaderData.undoable.filter(
    (decision) => new Date(decision.undoableUntil).getTime() > now
  );

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          {openRequests.length === 0
            ? "No open refund requests."
            : openRequests.length === 1
              ? "One open refund request, waiting on a decision."
              : `${openRequests.length} open refund requests, oldest first.`}
        </p>
      </div>

      {undoable.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Just decided</h2>
          <div className="space-y-2">
            {undoable.map((decision) => (
              <UndoableDecisionRow key={decision.id} decision={decision} />
            ))}
          </div>
        </section>
      )}

      {openRequests.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CircleCheck className="size-10 text-muted-foreground" />
            <p className="text-muted-foreground">You're all caught up.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {openRequests.map((request) => (
            <OpenRequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins and instructors can decide refund requests.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
