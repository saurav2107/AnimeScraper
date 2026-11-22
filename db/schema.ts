import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Timestamps are ISO-8601 TEXT, ids are crypto.randomUUID() strings (PRD §8).

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sizeKind: text("size_kind", { enum: ["height", "length", "scale", "other"] }).notNull(),
  sizeLabel: text("size_label").notNull(),
  sizeUnit: text("size_unit"),
  created: text("created").notNull(),
  updated: text("updated").notNull(),
  deletedAt: text("deleted_at"),
});

export const suppliers = sqliteTable("suppliers", {
  id: text("id").primaryKey(),
  categoryId: text("category_id").notNull().references(() => categories.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  status: text("status", { enum: ["Active", "Paused", "Deleted"] }).notNull().default("Paused"),
  config: text("config").notNull().default("{}"),
  lastSuccess: text("last_success"),
  deletedAt: text("deleted_at"),
  created: text("created").notNull(),
});

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id").notNull().references(() => categories.id),
    name: text("name").notNull(),
    image: text("image"),
    status: text("status", { enum: ["Active", "Merged", "Retired"] }).notNull().default("Active"),
    mergedIntoEventId: text("merged_into_event_id"),
    created: text("created").notNull(),
  },
  (t) => [index("groups_cat_status").on(t.categoryId, t.status), index("groups_cat_status_name").on(t.categoryId, t.status, t.name)],
);

export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id),
    groupId: text("group_id").notNull().references(() => groups.id),
    url: text("url").notNull(),
    name: text("name").notNull(),
    image: text("image"),
    height: text("height"),
    material: text("material"),
    sizeValue: text("size_value"),
    price: real("price"),
    previousPrice: real("previous_price"),
    priceChangedAt: text("price_changed_at"),
    currency: text("currency"),
    stock: text("stock").notNull().default("Unknown"),
    status: text("status").notNull().default("NEW"),
    raw: text("raw"),
    scraped: text("scraped").notNull(),
    created: text("created").notNull(),
  },
  (t) => [uniqueIndex("listings_url_uq").on(t.url), index("listings_group").on(t.groupId), index("listings_supplier").on(t.supplierId), index("listings_status").on(t.status)],
);

export const mergeEvents = sqliteTable("merge_events", {
  id: text("id").primaryKey(),
  categoryId: text("category_id").notNull().references(() => categories.id),
  resultGroupId: text("result_group_id").notNull().unique().references(() => groups.id),
  name: text("name").notNull(),
  image: text("image"),
  note: text("note"),
  created: text("created").notNull(),
  undoneAt: text("undone_at"),
});

export const mergeEventSources = sqliteTable(
  "merge_event_sources",
  {
    mergeEventId: text("merge_event_id").notNull().references(() => mergeEvents.id),
    sourceGroupId: text("source_group_id").notNull().references(() => groups.id),
  },
  (t) => [primaryKey({ columns: [t.mergeEventId, t.sourceGroupId] })],
);

export const mergeEventListings = sqliteTable(
  "merge_event_listings",
  {
    mergeEventId: text("merge_event_id").notNull().references(() => mergeEvents.id),
    listingId: text("listing_id").notNull().references(() => listings.id),
    fromGroupId: text("from_group_id").notNull().references(() => groups.id),
  },
  (t) => [primaryKey({ columns: [t.mergeEventId, t.listingId] })],
);

export const priceHistory = sqliteTable(
  "price_history",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull().references(() => listings.id),
    price: real("price"),
    currency: text("currency"),
    stock: text("stock").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [index("ph_listing_time").on(t.listingId, t.recordedAt), index("ph_time").on(t.recordedAt)],
);

export const history = sqliteTable(
  "history",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull(),
    kind: text("kind").notNull(), // NEW | PRICE UPDATED | OUT OF STOCK | STOCK UPDATED | REMOVED (no SNAPSHOT)
    previous: text("previous"),
    current: text("current"),
    at: text("at").notNull(),
  },
  (t) => [index("history_at").on(t.at), index("history_listing").on(t.listingId)],
);

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // Manual | Scheduled | Test
  status: text("status").notNull(), // Running | Completed | Completed with errors | Failed
  started: text("started").notNull(),
  finished: text("finished"),
  selected: text("selected").notNull().default("[]"),
  log: text("log").notNull().default("[]"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  data: text("data").notNull().default("{}"),
  at: text("at").notNull(),
});
