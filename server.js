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

        // ── Step 1: Log in ────────────────────────────────────────────────────────
        console.log(`[ACD] Logging in as ${acd_username}...`);
        await page.goto("https://www.acdd.com/login", { waitUntil: "networkidle" });

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

        // ── Step 2: Search ────────────────────────────────────────────────────────
        console.log(`[ACD] Searching for: ${product_name}`);
        await page.goto(
            `https://www.acdd.com/search?term=${encodeURIComponent(product_name)}`,
            { waitUntil: "networkidle" }
        );

        // ── Step 3: Parse results ─────────────────────────────────────────────────
        const result = await page.evaluate(() => {
            const items = document.querySelectorAll("div.group");

            if (!items || items.length === 0) {
                const bodyText = document.body.innerText.toLowerCase();
                if (
                    bodyText.includes("no results") ||
                    bodyText.includes("no products found") ||
                    bodyText.includes("0 results")
                ) {
                    return { found: false, status: "Not found", quantity: 0, matches: [] };
                }
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];

            items.forEach((item) => {
                // ── Name ───────────────────────────────────────────────────────
                const nameEl = item.querySelector("h3 a");
                if (!nameEl) return;
                const name = nameEl.innerText.trim();

                // ── SKU ────────────────────────────────────────────────────────
                const skuEl = Array.from(item.querySelectorAll("p")).find((p) =>
                    p.innerText.trim().startsWith("SKU:")
                );
                const sku = skuEl ? skuEl.innerText.replace("SKU:", "").trim() : "";

                // ── Qty Available (shown when logged in) ───────────────────────
                // e.g. "Qty Available: 0" or "Qty Available: 14"
                const qtyEl = Array.from(item.querySelectorAll("p")).find((p) =>
                    p.innerText.trim().startsWith("Qty Available:")
                );
                const qtyText = qtyEl ? qtyEl.innerText.replace("Qty Available:", "").trim() : null;
                const quantity = qtyText !== null ? parseInt(qtyText, 10) : null;

                // ── MSRP ───────────────────────────────────────────────────────
                const msrpEl = Array.from(item.querySelectorAll("p")).find((p) =>
                    p.innerText.trim().startsWith("MSRP:")
                );
                const msrp = msrpEl ? msrpEl.innerText.replace("MSRP:", "").trim() : "";

                // ── Price (distributor price) ──────────────────────────────────
                const priceWrapperEl = item.querySelector(".flex.flex-col.relative + * span.font-bold, span.font-bold");
                // More reliable: find the Price label and grab the adjacent span
                const priceLabelEl = Array.from(item.querySelectorAll("p")).find((p) =>
                    p.innerText.trim().startsWith("Price:")
                );
                let price = "";
                if (priceLabelEl) {
                    // Price is in a sibling span inside the same wrapper div
                    const priceContainer = priceLabelEl.closest("div");
                    const priceSpan = priceContainer ? priceContainer.querySelector("span.font-bold") : null;
                    price = priceSpan ? priceSpan.innerText.trim() : "";
                }

                // ── Preorder info ──────────────────────────────────────────────
                // Present when item has a preorder-countdown-grid block
                const preorderGrid = item.querySelector(".preorder-countdown-grid");
                let isPreorder = false;
                let orderDueText = "";
                let releaseDate = "";
                let orderByDate = "";

                if (preorderGrid) {
                    isPreorder = true;

                    // "Order Due: 76 Days"
                    const dueDaysEl = preorderGrid.querySelector(".preorder-countdown-list-text-green span");
                    orderDueText = dueDaysEl ? dueDaysEl.innerText.trim() : "";

                    // Release date and Order By date are in .text-date spans
                    const datePairs = preorderGrid.querySelectorAll(".text-date");
                    datePairs.forEach((el) => {
                        const text = el.innerText.trim();
                        if (text.startsWith("Release")) {
                            const bold = el.querySelector("span.font-bold");
                            releaseDate = bold ? bold.innerText.trim() : text.replace(/Release\s*(Date)?:?/i, "").trim();
                        } else if (text.startsWith("Order By")) {
                            const bold = el.querySelector("span.font-bold");
                            orderByDate = bold ? bold.innerText.trim() : text.replace(/Order By:?/i, "").trim();
                        }
                    });
                }

                // ── Action button type (Preorder vs Add to Cart) ───────────────
                // Also use button label as fallback: some preorders have no countdown grid yet
                const buttonEl = item.querySelector("button[type='submit']");
                const buttonLabel = buttonEl ? buttonEl.innerText.trim() : "";
                if (!isPreorder && buttonLabel.toLowerCase() === "preorder") {
                    isPreorder = true;
                }

                // ── Product URL ────────────────────────────────────────────────
                const linkEl = item.querySelector("h3 a");
                const href = linkEl ? linkEl.getAttribute("href") : "";
                const url = href
                    ? `https://www.acdd.com${href.startsWith("/") ? href : "/" + href}`
                    : "";

                matches.push({
                    name,
                    sku,
                    quantity,
                    msrp,
                    price,
                    is_preorder: isPreorder,
                    order_due: orderDueText,
                    release_date: releaseDate,
                    order_by_date: orderByDate,
                    button_label: buttonLabel,
                    url,
                });
            });

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            // ── Build summary status ───────────────────────────────────────────
            // Always list all matched products (up to 9) with qty and preorder flag.
            // Format: "Name (qty) // Name (qty) [Preorder] // ..."
            // For a single result, prepend a clear availability label.
            const productList = matches
                .slice(0, 9)
                .map((m) => {
                    const qty = m.quantity !== null ? ` (${m.quantity})` : "";
                    const tag = m.is_preorder ? " [Preorder]" : "";
                    return `${m.name}${qty}${tag}`;
                })
                .join(" // ");

            let statusMsg = "";
            if (matches.length === 1) {
                const m = matches[0];
                if (m.is_preorder) {
                    statusMsg = `Preorder — ${m.name}`;
                    if (m.order_due) statusMsg += `, ${m.order_due}`;
                    if (m.release_date) statusMsg += `, Release: ${m.release_date}`;
                    if (m.order_by_date) statusMsg += `, Order By: ${m.order_by_date}`;
                } else if (m.quantity > 0) {
                    statusMsg = `Available, ${m.quantity} in stock — ${m.name}`;
                } else {
                    statusMsg = `Available, but 0 stock — ${m.name}`;
                }
            } else {
                statusMsg = `${matches.length} products found — ${productList}`;
            }

            const inStockMatch = matches.find((m) => !m.is_preorder && m.quantity > 0);
            const best = inStockMatch || matches[0];

            return {
                found: true,
                status: statusMsg,
                quantity: best.quantity,
                in_stock: best.quantity !== null ? best.quantity > 0 : null,
                is_preorder: best.is_preorder,
                matches: matches.slice(0, 9),
            };
        });

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