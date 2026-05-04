const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SCRAPER_API_KEY || "change-me-in-env";

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const key = req.headers["x-api-key"];
    if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
    next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── ACD Distribution search ──────────────────────────────────────────────────
app.post("/search/acd", async (req, res) => {
    const { product_name, acd_username, acd_password } = req.body;

    if (!product_name || !acd_username || !acd_password) {
        return res.status(400).json({ error: "Missing product_name, acd_username, or acd_password" });
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();

        // ── Step 1: Log in ──────────────────────────────────────────────────────
        console.log(`[ACD] Logging in as ${acd_username}...`);
        await page.goto("https://www.acddist.com/login", { waitUntil: "networkidle" });

        await page.fill('input[name="email"], input[type="email"], #email', acd_username);
        await page.fill('input[name="password"], input[type="password"], #password', acd_password);
        await page.click('button[type="submit"], input[type="submit"], .login-btn');
        await page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => { });

        // Verify login succeeded
        const loginFailed =
            (await page.$('.login-error, .alert-danger, [class*="error"]')) !== null;
        if (loginFailed) {
            return res.status(401).json({ error: "ACD login failed — check credentials" });
        }

        // ── Step 2: Search ──────────────────────────────────────────────────────
        console.log(`[ACD] Searching for: ${product_name}`);
        await page.goto(
            `https://www.acddist.com/products?q=${encodeURIComponent(product_name)}`,
            { waitUntil: "networkidle" }
        );

        // ── Step 3: Parse results ───────────────────────────────────────────────
        const result = await page.evaluate((searchTerm) => {
            // Look for product cards / rows — adjust selectors if ACD updates their markup
            const items = document.querySelectorAll(
                ".product-card, .product-item, .search-result-item, [class*='product']"
            );

            if (!items || items.length === 0) {
                // Check for "no results" message
                const body = document.body.innerText.toLowerCase();
                if (
                    body.includes("no results") ||
                    body.includes("no products found") ||
                    body.includes("0 results")
                ) {
                    return { found: false, status: "Not found", quantity: 0, matches: [] };
                }
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];
            items.forEach((item) => {
                const nameEl = item.querySelector(
                    ".product-name, .product-title, h2, h3, [class*='name'], [class*='title']"
                );
                const stockEl = item.querySelector(
                    ".stock, .qty, .quantity, [class*='stock'], [class*='qty'], [class*='avail']"
                );
                const skuEl = item.querySelector(".sku, [class*='sku'], [class*='item-no']");

                if (!nameEl) return;

                const name = nameEl.innerText.trim();
                const stockText = stockEl ? stockEl.innerText.trim() : "";
                const sku = skuEl ? skuEl.innerText.trim() : "";

                // Parse quantity from stock text
                const qtyMatch = stockText.match(/\d+/);
                const qty = qtyMatch ? parseInt(qtyMatch[0], 10) : 0;

                const inStock =
                    qty > 0 ||
                    stockText.toLowerCase().includes("in stock") ||
                    stockText.toLowerCase().includes("available");

                matches.push({ name, sku, stock_text: stockText, quantity: qty, in_stock: inStock });
            });

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const best = matches[0];
            const statusMsg = best.in_stock
                ? `Available, ${best.quantity} in stock`
                : `Available, but 0 stock`;

            return {
                found: true,
                status: statusMsg,
                quantity: best.quantity,
                in_stock: best.in_stock,
                matches: matches.slice(0, 5),
            };
        }, product_name);

        console.log(`[ACD] Result for "${product_name}":`, result.status);
        return res.json({
            distributor: "ACD Distribution",
            product_name,
            ...result,
        });
    } catch (err) {
        console.error("[ACD] Error:", err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => console.log(`Vendor lookup scraper running on port ${PORT}`));