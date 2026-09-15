import { describe, it, expect, beforeAll } from "vite-plus/test";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { apiFetch } from "./setup/session";

/**
 * The migrations that ran before the book's own conversation existed, and the
 * one that rebuilt `chat_messages` to hold it.
 *
 * Split rather than applied together because the rebuild has a part that only
 * runs when there is something to carry: every other test file builds its
 * database from the whole list at once, which leaves `chat_messages` empty at
 * the moment the table is dropped and made again. That part of 0005 is the only
 * thing in this repository that can lose a reader's answers, so it is run here
 * the way a deploy runs it — on a database that already holds conversations.
 */
const BEFORE_BOOK_CHAT = env.TEST_MIGRATIONS.filter(
  (migration) => migration.name < "0005_book_chat.sql",
);
const FROM_BOOK_CHAT = env.TEST_MIGRATIONS.filter(
  (migration) => migration.name >= "0005_book_chat.sql",
);

beforeAll(async () => {
  await applyD1Migrations(env.DB, BEFORE_BOOK_CHAT);
});

/** A book and a highlight stored the way the code before 0005 stored them. */
async function storeBeforeTheRebuild(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pdfs (id, file_path, file_name, file_hash, full_text, page_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "legacy-book",
      "pdfs/legacy.pdf",
      "legacy.pdf",
      "legacy-hash",
      "Page 1 says fact-1.",
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO selections (id, pdf_id, selected_text, page_number, position_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "legacy-selection",
      "legacy-book",
      "fact-1",
      1,
      '{"rects":[]}',
      "2026-01-01T00:00:00.000Z",
    )
    .run();

  // No `pdf_id` in sight: that column is what the rebuild adds.
  for (const [id, role, content, citations, createdAt] of [
    ["legacy-question", "user", "これは何?", null, "2026-01-01T00:00:00.000Z"],
    [
      "legacy-answer",
      "assistant",
      "答えです",
      '[{"id":"1","type":"pdf","text":"Page 1 says fact-1."}]',
      "2026-01-01T00:00:01.000Z",
    ],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, selection_id, role, content, citations,
                                  input_tokens, output_tokens, cached_input_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        "legacy-selection",
        role,
        content,
        citations,
        role === "assistant" ? 11 : null,
        role === "assistant" ? 2 : null,
        role === "assistant" ? 9 : null,
        createdAt,
      )
      .run();
  }
}

describe("the migration that rebuilds chat_messages", () => {
  it("carries the conversations stored before it across, with their book and their cost", async () => {
    await storeBeforeTheRebuild();

    await applyD1Migrations(env.DB, FROM_BOOK_CHAT);

    // The book every row hung off is now written on the row itself.
    expect(
      await env.DB.prepare(
        "SELECT pdf_id, input_tokens, cached_input_tokens FROM chat_messages WHERE id = 'legacy-answer'",
      ).first(),
    ).toStrictEqual({ pdf_id: "legacy-book", input_tokens: 11, cached_input_tokens: 9 });

    // And the conversation reads back through the code that was written for the
    // rebuilt table, citations included.
    const body = (await (
      await apiFetch("https://example.com/api/pdf/legacy-book/selections/legacy-selection/chats")
    ).json()) as { messages: { id: string; content: string; citations: unknown }[] };

    expect(body.messages).toStrictEqual([
      {
        id: "legacy-question",
        role: "user",
        content: "これは何?",
        citations: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "legacy-answer",
        role: "assistant",
        content: "答えです",
        // Exactly what was written: the page a quote sits on is looked up when
        // the answer is stored, not when it is read back.
        citations: [{ id: "1", type: "pdf", text: "Page 1 says fact-1." }],
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
  });

  it("takes the book's own conversation too, once the table can hold one", async () => {
    // The other half of the rebuild: `selection_id` is nullable now, which is
    // what makes a question about the book itself storable at all.
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, selection_id, pdf_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "book-question",
        null,
        "legacy-book",
        "user",
        "この本を要約して",
        "2026-01-01T00:00:02.000Z",
      )
      .run();

    const body = (await (
      await apiFetch("https://example.com/api/pdf/legacy-book/chats")
    ).json()) as { messages: { id: string }[] };

    expect(body.messages.map((message) => message.id)).toStrictEqual(["book-question"]);
  });
});
