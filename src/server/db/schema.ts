import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const pdfs = sqliteTable("pdfs", {
  id: text("id").primaryKey(),
  filePath: text("file_path").notNull().unique(),
  fileName: text("file_name").notNull(),
  fileHash: text("file_hash").notNull().unique(),
  fullText: text("full_text").notNull(),
  pageCount: integer("page_count").notNull(),
  // Top-level chapters as JSON ({ title, pageNumber }[]). NULL — books stored
  // before the column, or PDFs that ship no outline — sends chat a page window
  // around the highlight instead of a chapter.
  outline: text("outline"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // Where the reader left off. Null on books nobody has opened yet, and on the
  // two panel columns also on books only ever read on a narrow screen, where
  // the outline is a drawer and the chat a sheet rather than places beside the
  // page.
  lastReadPage: integer("last_read_page"),
  lastReadSelectionId: text("last_read_selection_id"),
  // Whether that conversation was the book's own. At most one of the two is
  // set; both null is a place with no conversation open on it.
  lastReadBookChat: integer("last_read_book_chat", { mode: "boolean" }),
  lastReadOutlineOpen: integer("last_read_outline_open", { mode: "boolean" }),
  lastReadChatPanelOpen: integer("last_read_chat_panel_open", { mode: "boolean" }),
});

export const selections = sqliteTable("selections", {
  id: text("id").primaryKey(),
  pdfId: text("pdf_id")
    .notNull()
    .references(() => pdfs.id, { onDelete: "cascade" }),
  selectedText: text("selected_text").notNull(),
  pageNumber: integer("page_number").notNull(),
  positionData: text("position_data").notNull(),
  color: text("color").notNull().default("#FFEB3B"),
  createdAt: text("created_at").notNull(),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  // Null for the book's own conversation, which hangs off no passage. A
  // highlight's conversation still goes with the highlight: deleting it takes
  // the messages, while the book's own outlive every highlight in it.
  selectionId: text("selection_id").references(() => selections.id, { onDelete: "cascade" }),
  // Which book the message belongs to. Carried on every row rather than read
  // through the highlight, so a conversation about the book itself has one
  // place to hang from and deleting the book takes all of them.
  pdfId: text("pdf_id")
    .notNull()
    .references(() => pdfs.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  citations: text("citations"),
  // What the answer cost. Null on rows written before this was measured, and on
  // the reader's own messages, which cost nothing on their own.
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  createdAt: text("created_at").notNull(),
});
