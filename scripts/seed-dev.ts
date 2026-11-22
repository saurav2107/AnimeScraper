// Seeds a LIVE local database with the sample data so the app has something to show: `npm run db:seed-demo`
import { liveDb } from "../db";
import { seedDemo } from "../lib/demo";

const db = liveDb();
const n = (db.prepare("SELECT COUNT(*) AS c FROM categories").get() as { c: number }).c;
if (n) {
  console.log("Database already has categories; not seeding.");
} else {
  seedDemo(db);
  console.log("Seeded sample data.");
}
