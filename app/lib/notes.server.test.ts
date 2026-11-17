import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { getNote, listNotes, saveNote } from "./notes.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("saving a Note", () => {
  it("creates a Note with the body trimmed", () => {
    expect(
      saveNote(db, base.user.id, lessonIds[0], "  Rewatch at 4:10  ", NOW)
    ).toMatchObject({ ok: true });

    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Rewatch at 4:10",
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves the last edited time on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "First thought", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Second thought", minutesAfter(5));

    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Second thought",
      updatedAt: minutesAfter(5).toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("keeps the body exactly as typed, Markdown characters included", () => {
    saveNote(db, base.user.id, lessonIds[0], "# Not a heading\n*not bold*", NOW);

    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe(
      "# Not a heading\n*not bold*"
    );
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    expect(
      saveNote(db, base.user.id, lessonIds[0], "a".repeat(2000), NOW)
    ).toMatchObject({ ok: true });
  });

  it("refuses a Note over 2,000 characters with a message", () => {
    expect(
      saveNote(db, base.user.id, lessonIds[0], "a".repeat(2001), NOW)
    ).toEqual({ ok: false, error: "Notes must be 2,000 characters or fewer." });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });

  it("clears the Note when saved empty", () => {
    saveNote(db, base.user.id, lessonIds[0], "Something", NOW);
    saveNote(db, base.user.id, lessonIds[0], "   ", minutesAfter(1));

    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });

  it("never leaves a Student with two Notes on one Lesson", () => {
    saveNote(db, base.user.id, lessonIds[0], "Mine", NOW);
    expect(() =>
      db
        .insert(schema.notes)
        .values({ userId: base.user.id, lessonId: lessonIds[0], body: "Copy" })
        .run()
    ).toThrow();
  });
});

describe("listing Notes", () => {
  it("lists only the Student's own Notes, last edited first, with their Lesson and Course", () => {
    const other = db
      .insert(schema.users)
      .values({ name: "Other", email: "other@example.com", role: UserRole.Student })
      .returning()
      .get();
    saveNote(db, base.user.id, lessonIds[0], "Older", NOW);
    saveNote(db, base.user.id, lessonIds[1], "Newer", minutesAfter(5));
    saveNote(db, other.id, lessonIds[0], "Not mine", minutesAfter(10));
    saveNote(db, base.user.id, lessonIds[0], "Older, edited", minutesAfter(15));

    expect(listNotes(db, base.user.id)).toMatchObject([
      {
        body: "Older, edited",
        lessonId: lessonIds[0],
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
      {
        body: "Newer",
        lessonId: lessonIds[1],
        lessonTitle: "Lesson 2",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      },
    ]);
  });
});
