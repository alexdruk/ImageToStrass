import fs from "node:fs/promises";
import path from "node:path";

const SHOP_FILE = path.resolve("data/etsy-shop.json");

export async function saveShop(shop) {
  await fs.mkdir(path.dirname(SHOP_FILE), { recursive: true });

  await fs.writeFile(
    SHOP_FILE,
    JSON.stringify({
      shop_id: shop.shop_id,
      shop_name: shop.shop_name,
      saved_at: new Date().toISOString()
    }, null, 2),
    "utf8"
  );
}

export async function loadShop() {
  try {
    return JSON.parse(await fs.readFile(SHOP_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
