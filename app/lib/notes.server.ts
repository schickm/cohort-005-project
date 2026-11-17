import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { courses, lessons, modules, notes } from "~/db/schema";
import { MAX_NOTE_LENGTH, NOTE_TOO_LONG } from "~/lib/notes";

// ─── Notes ───
// A Student's own plain-text writing about a Lesson, private to the Student
// who wrote it. One per Student per Lesson, enforced by the unique index on
// (user_id, lesson_id). See GLOSSARY.md.
//
// Only the owning Student's Lesson page and Saved page may read Note bodies.
// No Instructor or Platform Admin view calls into this module.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Callers check content access before calling (loader guards don't
// protect actions). Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

type Note = typeof notes.$inferSelect;

/** The Student's Note on a Lesson, or undefined if they have not written one. */
export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select({ body: notes.body, updatedAt: notes.updatedAt })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

export type SaveNoteResult =
  | { ok: true; note: Note | null }
  | { ok: false; error: string };

/**
 * Creates the Student's Note on a Lesson, or replaces its body and moves
 * `updatedAt` on. The body is trimmed; over the cap it is refused, never
 * truncated. An empty body clears the Note, so an empty box always means
 * "no Note".
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const trimmed = body.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: NOTE_TOO_LONG };
  }

  if (trimmed.length === 0) {
    db.delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
      .run();
    return { ok: true, note: null };
  }

  const at = now.toISOString();
  const note = db
    .insert(notes)
    .values({ userId, lessonId, body: trimmed, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: trimmed, updatedAt: at },
    })
    .returning()
    .get();

  return { ok: true, note };
}

/** The Student's Notes, most recently edited first, each with the Lesson and Course it belongs to. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      moduleTitle: modules.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(notes)
    .innerJoin(lessons, eq(lessons.id, notes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
