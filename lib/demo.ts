import type { DB } from "@/db";
import { mergeProducts } from "./merge";
import { setSetting, uid } from "./util";

/** Sample workspace (FR-PG-08): 2 categories, 5 suppliers, OOS / price-change / removed / multi-listing cells and two dependent merges. */
export function seedDemo(db: DB) {
  const T = new Date().toISOString();
  const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  const cat = (name: string, kind: string, label: string, unit: string) => {
    const id = uid();
    db.prepare("INSERT INTO categories (id,name,size_kind,size_label,size_unit,created,updated) VALUES (?,?,?,?,?,?,?)").run(id, name, kind, label, unit, T, T);
    return id;
  };
  const sup = (categoryId: string, name: string, url: string) => {
    const id = uid();
    const cfg = JSON.stringify({ adapter: "woocommerce-api", productUrls: [], sitemapUrls: [], termsAcknowledged: true });
    db.prepare("INSERT INTO suppliers (id,category_id,name,url,status,config,last_success,created) VALUES (?,?,?,?,?,?,?,?)").run(id, categoryId, name, url, "Active", cfg, T, T);
    return id;
  };
  const figures = cat("Action Figures", "height", "Height", "cm");
  const katanas = cat("Katanas", "length", "Length", "cm");
  const a1 = sup(figures, "Otaku Mart", "https://otakumart.example/product-category/figures/");
  const a2 = sup(figures, "Figure Vault", "https://figurevault.example/product-category/figures/");
  const a3 = sup(figures, "Toy Bazaar", "https://toybazaar.example/product-category/figures/");
  const k1 = sup(katanas, "Samurai Depot", "https://samuraidepot.example/product-category/katanas/");
  const k2 = sup(katanas, "Blade Bazaar", "https://bladebazaar.example/product-category/katanas/");

  const prod = (categoryId: string, supplierId: string, host: string, name: string, o: { price: number | null; stock?: string; status?: string; prev?: number; size?: string }) => {
    const gid = uid(), lid = uid();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    db.prepare("INSERT INTO groups (id,category_id,name,status,created) VALUES (?,?,?,?,?)").run(gid, categoryId, name, "Active", day(5));
    db.prepare(
      `INSERT INTO listings (id,supplier_id,group_id,url,name,size_value,height,price,previous_price,price_changed_at,currency,stock,status,raw,scraped,created)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(lid, supplierId, gid, `https://${host}/product/${slug}`, name, o.size ?? null, o.size ?? null, o.price, o.prev ?? null, o.prev ? T : null, "INR", o.stock ?? "In stock", o.status ?? "Current", "null", T, day(5));
    // 30-day-window price log (FR-HIS-01)
    for (const [i, p] of [[10, (o.prev ?? o.price)], [5, (o.prev ?? o.price)], [0, o.price]] as Array<[number, number | null]>) {
      db.prepare("INSERT INTO price_history (id,listing_id,price,currency,stock,recorded_at) VALUES (?,?,?,?,?,?)").run(uid(), lid, p, "INR", o.stock ?? "In stock", day(i));
    }
    return gid;
  };

  prod(figures, a1, "otakumart.example", "Goku Ultra Instinct Figure", { price: 1299, prev: 1499, status: "PRICE UPDATED", size: "30" });
  prod(figures, a2, "figurevault.example", "Goku UI Statue", { price: 1450, stock: "Out of stock", status: "OUT OF STOCK", size: "30" });
  const l1 = prod(figures, a1, "otakumart.example", "Luffy Gear 5 Figure", { price: 999, size: "28" });
  const l1b = prod(figures, a1, "otakumart.example", "Luffy Gear 5 Box Set", { price: 1100, size: "28" });
  const l2 = prod(figures, a2, "figurevault.example", "Luffy Gear Five Collectible", { price: 1020, status: "REMOVED", size: "28" });
  const l3 = prod(figures, a3, "toybazaar.example", "Luffy Gear 5 Deluxe (Toy Bazaar)", { price: 1050, size: "28" });
  prod(figures, a1, "otakumart.example", "Naruto Sage Mode Figure", { price: 1799, status: "NEW", size: "25" });
  prod(figures, a3, "toybazaar.example", "Naruto Sage Mode Statue", { price: 1899, prev: 1699, status: "PRICE UPDATED", size: "25" });
  prod(figures, a2, "figurevault.example", "Zoro Wano Figure", { price: 1599, size: "24" });
  prod(figures, a1, "otakumart.example", "Itachi Uchiha Figure", { price: 1199, size: "22" });
  prod(figures, a3, "toybazaar.example", "Itachi Uchiha Akatsuki", { price: 1249 });
  prod(katanas, k1, "samuraidepot.example", "Demon Slayer Nichirin Katana", { price: 2499, size: "104" });
  prod(katanas, k2, "bladebazaar.example", "Nichirin Blade Replica", { price: 2299, prev: 2599, status: "PRICE UPDATED", size: "102" });
  prod(katanas, k1, "samuraidepot.example", "Zangetsu Bankai Sword", { price: 3199, stock: "Out of stock", status: "OUT OF STOCK", size: "120" });
  prod(katanas, k2, "bladebazaar.example", "Wooden Bokken Training Sword", { price: 799, size: "100" });

  // Two dependent merges (the second consumes the first's result)
  const m1 = mergeProducts(db, { productIds: [l1, l1b, l2], name: "Luffy Gear 5 Figure", image: null, note: "Same Gear 5 pose, three listings" });
  mergeProducts(db, { productIds: [m1.productId, l3], name: "Luffy Gear 5 Deluxe", image: null, note: "Toy Bazaar's deluxe edition is the same figure" });

  setSetting(db, "automatic", "0");
  const log = [{ supplierId: a1, supplier: "Otaku Mart", status: "Completed", discovered: 5, added: 5, updated: 0, removed: 0, skippedDuplicates: 0, skippedExamples: [], errors: [] }];
  db.prepare("INSERT INTO jobs (id,kind,status,started,finished,selected,log) VALUES (?,?,?,?,?,?,?)").run(uid(), "Manual", "Completed", day(1), day(1), JSON.stringify([a1]), JSON.stringify(log));
}
