import { sql } from "drizzle-orm";
import { courseRatings, enrollments } from "~/db/schema";

/**
 * A rating counts towards a course's average only while its author is a
 * Learner on the course. A learner whose refund is approved stops counting;
 * their rating is kept in case they come back.
 */
export const ratingByCurrentLearner = sql`exists (select 1 from ${enrollments} where ${enrollments.userId} = ${courseRatings.userId} and ${enrollments.courseId} = ${courseRatings.courseId})`;
