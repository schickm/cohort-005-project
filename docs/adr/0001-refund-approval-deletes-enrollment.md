# Approving a refund deletes the enrollment

A learner whose Refund Request is approved stops being a Learner on that course, and that has to hold everywhere: the course pages, the roster, analytics and rating averages. Around 18 queries decide whether someone is a Learner just by checking that an `enrollments` row exists. So approving deletes the row instead of marking it. That way every one of those queries is already correct, including ones written later. Their progress, quiz attempts, watch history, ratings and comments are kept, because none of those depend on the enrollment row.

## Considered Options

- **Mark the enrollment as refunded** (for example a `refundedAt` column). Rejected because every query that reads enrollments would need a filter. Missing one doesn't cause an error: a refunded learner just quietly keeps showing up somewhere.
- **Work it out from the refund each time** (access checks look for an approved refund on the latest purchase). Rejected for the same reason: every reader would have to know about refunds.

## Consequences

- Undo has to rebuild the row it deleted. The approval saves the enrollment's `enrolledAt` and `completedAt` to `refunds.revoked_enrollment`. Undo puts them back, and it's refused if the learner has enrolled again in the meantime.
- The new enrollment row from buying again starts with a fresh `enrolledAt`. The learner's progress carries over, because progress is stored per user and lesson.
- Approving a team licence deletes no enrollment. Nobody is enrolled through the purchase itself: the buyer gets seats, not a place on the course. Instead, unclaimed seats stop working, which is checked against the refund when someone redeems a seat.
- If you later need a history of who held an enrollment, you won't get it from `enrollments`. Use `revoked_enrollment` on approved refunds.
