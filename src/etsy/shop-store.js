import fs from "node:fs/promises";
import path from "node:path";

const SHOP_FILE = path.resolve("data/etsy-shop.json");

// file: another place than data/etsy-shop.json (tests).
export async function saveShop(shop, file = SHOP_FILE) {
  await fs.mkdir(path.dirname(file), { recursive: true });

  await fs.writeFile(
    file,
    JSON.stringify({
      shop_id: shop.shop_id,
      shop_name: shop.shop_name,
      saved_at: new Date().toISOString()
    }, null, 2),
    "utf8"
  );
}

export async function loadShop(file = SHOP_FILE) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
