require("dotenv").config();

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
                    price,
                    msrp,
                    url,
                    in_stock: quantity !== null ? quantity > 0 : null,
                    is_preorder: isPreorder,
                    order_due: orderDueText,
                    release_date: releaseDate,
                    order_by_date: orderByDate,
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

// ─── asmodee search ─────────────────────────────────────────────
app.post("/search/asmodee", async (req, res) => {
    const { product_name, username, password } = req.body;

    if (!product_name || !username || !password) {
        return res.status(400).json({ error: "Missing product_name, username, or password" });
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

        // ── Step 1: Log in ────────────────────────────────────────────────────
        console.log(`ASMODEE Logging in as ${username}...`);
        await page.goto("https://shop.asmodee.com/profile/login", { waitUntil: "networkidle" });

        // Dismiss cookie consent modal
        try {
            await page.waitForSelector('#didomi-notice-agree-button', { state: 'visible', timeout: 8000 });
            await page.click('#didomi-notice-agree-button');
            // Wait for the modal to fully disappear before proceeding
            await page.waitForSelector('#didomi-notice-agree-button', { state: 'hidden', timeout: 8000 });
            console.log("[ASMODEE] Cookie modal dismissed");
        } catch {
            console.log("[ASMODEE] No cookie modal, continuing...");
        }

        await page.waitForTimeout(2000);
        console.log("[ASMODEE] URL after cookie dismiss:", page.url());
        console.log("[ASMODEE] Page title:", await page.title());
        console.log("[ASMODEE] Page HTML snippet:", (await page.content()).substring(0, 3000));

        // Now wait explicitly for the login form to be ready before filling
        await page.waitForSelector('input[name="UserName"]', { state: 'visible', timeout: 15000 });

        // Confirm login succeeded by checking we're no longer on the login page
        const loginFailed = page.url().includes("/login");
        if (loginFailed) {
            return res.status(401).json({ error: "Login failed — check credentials" });
        }

        // ── Step 2: Search ────────────────────────────────────────────────────
        console.log(`ASMODEE Searching for: ${product_name}`);
        await page.goto(
            `https://shop.asmodee.com/search?q=${encodeURIComponent(product_name)}`,
            { waitUntil: "networkidle" }
        );

        // ── Step 3: Parse results ─────────────────────────────────────────────
        const result = await page.evaluate(() => {
            const items = document.querySelectorAll("div.l-products-item");

            if (!items || items.length === 0) {
                const bodyText = document.body.innerText.toLowerCase();
                if (bodyText.includes("no results") || bodyText.includes("no products found")) {
                    return { found: false, status: "Not found", quantity: 0, matches: [] };
                }
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];
            items.forEach((item) => {
                const nameEl = item.querySelector('a.product-title span[itemprop="name"]');
                if (!nameEl) return;

                const name = nameEl.innerText.trim();

                const skuEl = item.querySelector("span.product-id-value");
                const sku = skuEl ? skuEl.innerText.replace(/sku:?/i, "").trim() : "";

                const stockEl = item.querySelector("span.lbl-stock");
                const stockText = stockEl ? stockEl.innerText.trim() : "";
                const inStock = stockEl ? stockEl.classList.contains("in-stock") : false;
                const isPreorder = stockText.toLowerCase().includes("pre order") ||
                    stockText.toLowerCase().includes("back order");
                const quantity = inStock ? 1 : 0; // No exact number exposed, use 1 as "in stock" flag

                const priceEl = item.querySelector("span.lbl-price");
                const price = priceEl ? priceEl.innerText.trim() : "";

                const href = item.querySelector("a.product-title")?.getAttribute("href")?.split("?")[0] || "";
                const url = href
                    ? `https://shop.asmodee.com${href.startsWith("/") ? href : "/" + href}`
                    : "";

                matches.push({ name, sku, quantity, price, url, in_stock: inStock, is_preorder: isPreorder });
            });

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const productList = matches
                .slice(0, 9)
                .map((m) => {
                    const qty = m.quantity !== null ? ` (${m.quantity})` : "";
                    return `${m.name}${qty}`;
                })
                .join(" // ");

            let statusMsg = "";
            if (matches.length === 1) {
                const m = matches[0];
                if (m.is_preorder) {
                    statusMsg = `Back Order / Pre Order — ${m.name}`;
                } else if (m.in_stock) {
                    statusMsg = `In Stock — ${m.name}`;
                } else {
                    statusMsg = `Out of Stock — ${m.name}`;
                }
            } else {
                statusMsg = `${matches.length} products found — ${productList}`;
            }

            const best = matches.find((m) => m.quantity > 0) || matches[0];

            return {
                found: true,
                status: statusMsg,
                quantity: best.quantity,
                in_stock: best.quantity !== null ? best.quantity > 0 : null,
                matches: matches.slice(0, 9),
            };
        });

        console.log(`ASMODEE Result for "${product_name}":`, result.status);
        return res.json({
            distributor: "ASMODEE",
            product_name,
            ...result,
        });

    } catch (err) {
        console.error("ASMODEE Error:", err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ─── Universal Distribution (Alliance) search ─────────────────────────────────
app.post("/search/universal", async (req, res) => {
    const { product_name, username, password } = req.body;

    if (!product_name || !username || !password) {
        return res.status(400).json({ error: "Missing product_name, username, or password" });
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

        // ── Step 1: Log in ────────────────────────────────────────────────────
        console.log(`[UNIVERSAL] Logging in as ${username}...`);
        await page.goto("https://us.universaldist.com/login", { waitUntil: "networkidle" });

        // Universal is an Angular SPA — wait for the login form to be rendered
        await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 15000 });
        await page.fill('input[placeholder="Email Address"]', username);

        await page.waitForSelector('input[type="password"]', { timeout: 10000 });
        await page.fill('input[placeholder="password"]', password);

        await page.click('button:has-text("Login")');
        await page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => { });

        // Verify login — if still on /login, credentials failed
        if (page.url().includes("/login")) {
            return res.status(401).json({ error: "Universal login failed — check credentials" });
        }
        console.log(`[UNIVERSAL] Logged in. Current URL: ${page.url()}`);

        // ── Step 2: Search ────────────────────────────────────────────────────
        // Universal uses keyword + term params. "in-stock" shows all results including 0-stock.
        // Remove the term filter so we get everything including preorders.
        console.log(`[UNIVERSAL] Searching for: ${product_name}`);
        await page.goto(
            `https://us.universaldist.com/search-list?keyword=${encodeURIComponent(product_name)}`,
            { waitUntil: "networkidle" }
        );

        // Angular renders results asynchronously — wait for product rows to appear
        try {
            await page.waitForSelector("tr.ng-star-inserted", { timeout: 15000 });
        } catch {
            // No results rendered — check for empty state message
            const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
            if (bodyText.includes("no result") || bodyText.includes("no product") || bodyText.includes("0 result")) {
                return res.json({ distributor: "Universal Distribution", product_name, found: false, status: "Not found", quantity: 0, matches: [] });
            }
            return res.json({ distributor: "Universal Distribution", product_name, found: false, status: "Not found", quantity: 0, matches: [] });
        }

        // ── Step 3: Parse results ─────────────────────────────────────────────
        const result = await page.evaluate(() => {
            const rows = document.querySelectorAll("tr.ng-star-inserted");

            if (!rows || rows.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];

            rows.forEach((row) => {
                // ── Name ───────────────────────────────────────────────────────
                // Format: "MONOPOLY POKEMON (6)" — strip the trailing case qty in parens
                const nameEl = row.querySelector(".item-title");
                if (!nameEl) return;
                const rawName = nameEl.innerText.trim();
                const name = rawName.replace(/\s*\(\d+\)\s*$/, "").trim(); // strip "(6)" suffix
                const caseQty = rawName.match(/\((\d+)\)\s*$/)?.[1] || null;

                // ── Price ──────────────────────────────────────────────────────
                // First .ng-star-inserted div inside .price contains the price
                const priceEl = row.querySelector(".price .ng-star-inserted");
                const price = priceEl ? priceEl.innerText.trim() : "";

                // ── Discount ───────────────────────────────────────────────────
                const discountEl = row.querySelector(".text-danger.ng-star-inserted");
                const discount = discountEl ? discountEl.innerText.trim() : "";

                // ── Warehouse availability ─────────────────────────────────────
                // Each warehouse is a span.warehouse — isAvailable class = in stock there
                const warehouseEls = row.querySelectorAll("span.warehouse");
                const warehouses = [];
                let availableCount = 0;

                warehouseEls.forEach((w) => {
                    const code = w.innerText.trim();
                    const available = w.classList.contains("isAvailable");
                    if (code) {
                        warehouses.push({ code, available });
                        if (available) availableCount++;
                    }
                });

                const inStock = availableCount > 0;

                // Build a readable warehouse string: "RDL ✓ / FWA ✓ / AUS ✓ / VIS ✗"
                const warehouseStr = warehouses
                    .map((w) => `${w.code}${w.available ? " ✓" : " ✗"}`)
                    .join(" / ");

                matches.push({
                    name,
                    case_qty: caseQty,
                    price,
                    discount,
                    in_stock: inStock,
                    available_warehouses: availableCount,
                    total_warehouses: warehouses.length,
                    warehouses: warehouseStr,
                    is_preorder: false, // Universal shows live stock only
                });
            });

            // Deduplicate by name — Universal sometimes returns the same product twice
            const seen = new Set();
            const uniqueMatches = matches.filter((m) => {
                if (seen.has(m.name)) return false;
                seen.add(m.name);
                return true;
            });
            matches.length = 0;
            uniqueMatches.forEach((m) => matches.push(m));

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            // ── Build status string ────────────────────────────────────────────
            // Universal doesn't expose exact qty — use warehouse availability instead
            const productList = matches
                .slice(0, 9)
                .map((m) => {
                    const stock = m.in_stock
                        ? `${m.available_warehouses}/${m.total_warehouses} warehouses`
                        : "No stock";
                    return `${m.name} (${stock})`;
                })
                .join(" // ");

            let statusMsg = "";
            if (matches.length === 1) {
                const m = matches[0];
                statusMsg = m.in_stock
                    ? `Available — ${m.name}, ${m.available_warehouses}/${m.total_warehouses} warehouses [${m.warehouses}]`
                    : `Available, but no stock — ${m.name}`;
            } else {
                statusMsg = `${matches.length} products found — ${productList}`;
            }

            const best = matches.find((m) => m.in_stock) || matches[0];

            return {
                found: true,
                status: statusMsg,
                quantity: best.available_warehouses, // warehouses as proxy for qty
                in_stock: best.in_stock,
                is_preorder: false,
                matches: matches.slice(0, 9),
            };
        });

        console.log(`[UNIVERSAL] Result for "${product_name}":`, result.status);
        return res.json({
            distributor: "Universal Distribution",
            product_name,
            ...result,
        });

    } catch (err) {
        console.error("[UNIVERSAL] Error:", err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ─── Stonemaier Games search ────────────────────────────────────────────────
// No login required — public Shopify store with embedded JSON product data.
// This is the most reliable scraper in the stack since we parse structured
// JSON instead of guessing at CSS selectors.
app.post("/search/stonemaier", async (req, res) => {
    const { product_name } = req.body;

    if (!product_name) {
        return res.status(400).json({ error: "Missing product_name" });
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

        // ── Search (no login step at all) ───────────────────────────────────────
        console.log(`[STONEMAIER] Searching for: ${product_name}`);
        await page.goto(
            `https://store.stonemaiergames.com/search?type=product&options[prefix]=last&q=${encodeURIComponent(product_name)}`,
            { waitUntil: "networkidle" }
        );

        // ── Parse results from embedded JSON ────────────────────────────────────
        const result = await page.evaluate(() => {
            // Each product card has a <script class="ProductJson-{id}"> with clean JSON
            const jsonScripts = document.querySelectorAll('script[class^="ProductJson-"]');

            if (!jsonScripts || jsonScripts.length === 0) {
                const bodyText = document.body.innerText.toLowerCase();
                if (bodyText.includes("no results") || bodyText.includes("no products found")) {
                    return { found: false, status: "Not found", quantity: 0, matches: [] };
                }
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];

            jsonScripts.forEach((script) => {
                let data;
                try {
                    data = JSON.parse(script.textContent);
                } catch {
                    return; // skip malformed JSON
                }

                const name = data.title || "";
                if (!name) return;

                // Price is in cents — convert to dollars
                const price = data.price ? `$${(data.price / 100).toFixed(2)}` : "";
                const compareAtPrice = data.compare_at_price
                    ? `$${(data.compare_at_price / 100).toFixed(2)}`
                    : "";
                const onSale = data.compare_at_price && data.compare_at_price > data.price;

                // Variants carry the real inventory data
                const variant = (data.variants && data.variants[0]) || {};
                const sku = variant.sku || "";
                const quantity = typeof variant.inventory_quantity === "number"
                    ? variant.inventory_quantity
                    : null;
                const available = data.available === true;

                const url = data.handle ? `https://store.stonemaiergames.com/products/${data.handle}` : "";

                matches.push({
                    name,
                    sku,
                    quantity,
                    price,
                    msrp: compareAtPrice || price, // compare_at_price acts as MSRP when on sale
                    on_sale: onSale,
                    in_stock: available && (quantity === null || quantity > 0),
                    is_preorder: false,
                    url,
                });
            });

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            // ── Build status string ────────────────────────────────────────────
            const productList = matches
                .slice(0, 9)
                .map((m) => {
                    const qty = m.quantity !== null ? ` (${m.quantity})` : "";
                    const sale = m.on_sale ? " [Sale]" : "";
                    return `${m.name}${qty}${sale}`;
                })
                .join(" // ");

            let statusMsg = "";
            if (matches.length === 1) {
                const m = matches[0];
                if (m.in_stock) {
                    statusMsg = m.quantity !== null
                        ? `Available, ${m.quantity} in stock — ${m.name}`
                        : `Available — ${m.name}`;
                } else {
                    statusMsg = `Available, but 0 stock — ${m.name}`;
                }
            } else {
                statusMsg = `${matches.length} products found — ${productList}`;
            }

            const best = matches.find((m) => m.in_stock) || matches[0];

            return {
                found: true,
                status: statusMsg,
                quantity: best.quantity,
                in_stock: best.in_stock,
                is_preorder: false,
                matches: matches.slice(0, 9),
            };
        });

        console.log(`[STONEMAIER] Result for "${product_name}":`, result.status);
        return res.json({
            distributor: "Stonemaier Games",
            product_name,
            ...result,
        });

    } catch (err) {
        console.error("[STONEMAIER] Error:", err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ─── PHD Games search ───────────────────────────────────────────────────────
app.post("/search/phd", async (req, res) => {
    const { product_name, username, password } = req.body;

    if (!product_name || !username || !password) {
        return res.status(400).json({ error: "Missing product_name, username, or password" });
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

        // ── Step 1: Log in ────────────────────────────────────────────────────
        console.log(`[PHD] Logging in as ${username}...`);
        await page.goto("https://portal.phdgames.com/sign-in", { waitUntil: "networkidle" });

        // Angular Material app — exact formcontrolname selectors
        await page.waitForSelector('input[formcontrolname="email"]', { timeout: 15000 });
        await page.fill('input[formcontrolname="email"]', username);

        await page.waitForSelector('input[formcontrolname="password"]', { timeout: 10000 });
        await page.fill('input[formcontrolname="password"]', password);

        await page.click('button:has-text("Sign in"), button:has-text("Login"), button[type="submit"]');
        await page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => { });

        if (page.url().includes("/sign-in")) {
            return res.status(401).json({ error: "PHD Games login failed — check credentials" });
        }
        console.log(`[PHD] Logged in. Current URL: ${page.url()}`);

        // ── Step 2: Search ────────────────────────────────────────────────────
        console.log(`[PHD] Searching for: ${product_name}`);
        await page.goto(
            `https://portal.phdgames.com/products?s=${encodeURIComponent(product_name)}&st=keywords&page=1&size=20`,
            { waitUntil: "networkidle" }
        );

        // Angular renders rows asynchronously
        try {
            await page.waitForSelector("tr.mat-row", { timeout: 15000 });
        } catch {
            return res.json({ distributor: "PHD Games", product_name, found: false, status: "Not found", quantity: 0, matches: [] });
        }

        // ── Step 3: Parse results ─────────────────────────────────────────────
        const result = await page.evaluate(() => {
            const rows = document.querySelectorAll("tr.mat-row");

            if (!rows || rows.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];

            rows.forEach((row) => {
                const nameEl = row.querySelector(".cdk-column-name a.productname");
                if (!nameEl) return;
                const name = nameEl.innerText.trim();

                const skuEl = row.querySelector(".cdk-column-id a.productname");
                const sku = skuEl ? skuEl.innerText.trim() : "";

                const msrpEl = row.querySelector(".cdk-column-msrpPrice");
                const msrp = msrpEl ? msrpEl.innerText.trim() : "";

                // "Your Price" — the special business pricing
                const yourPriceEl = row.querySelector(".cdk-column-newPrice");
                const yourPrice = yourPriceEl ? yourPriceEl.innerText.trim() : "";

                // Availability count — the actual stock number
                const availEl = row.querySelector(".cdk-column-availabilityCountDisplay p");
                const availText = availEl ? availEl.innerText.trim() : null;
                const quantity = availText !== null ? parseInt(availText, 10) : null;

                // Stock status tag — e.g. "Out of stock"
                const stockTagEl = row.querySelector(".stock-tag");
                const stockTagText = stockTagEl ? stockTagEl.innerText.trim().toLowerCase() : "";
                const isPreorder = stockTagText.includes("preorder") || stockTagText.includes("pre-order");

                const releaseDateEl = row.querySelector(".cdk-column-releaseDate");
                const releaseDate = releaseDateEl ? releaseDateEl.innerText.trim() : "";

                const linkEl = row.querySelector("a.productname");
                const href = linkEl ? linkEl.getAttribute("href") : "";
                const url = href
                    ? `https://portal.phdgames.com${href.startsWith("/") ? href : "/" + href}`
                    : "";

                const inStock = quantity !== null ? quantity > 0 : !stockTagText.includes("out of stock");

                matches.push({
                    name,
                    sku,
                    quantity,
                    msrp,
                    price: yourPrice, // "your price" = business/wholesale price
                    in_stock: inStock,
                    is_preorder: isPreorder,
                    release_date: releaseDate,
                    url,
                });
            });

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

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
                    statusMsg = `Preorder — ${m.name}, Release: ${m.release_date}, MSRP: ${m.msrp}, Your Price: ${m.price}`;
                } else if (m.in_stock) {
                    statusMsg = `Available, ${m.quantity} in stock — ${m.name}, MSRP: ${m.msrp}, Your Price: ${m.price}`;
                } else {
                    statusMsg = `Available, but 0 stock — ${m.name}, MSRP: ${m.msrp}, Your Price: ${m.price}`;
                }
            } else {
                statusMsg = `${matches.length} products found — ${productList}`;
            }

            const best = matches.find((m) => m.in_stock && !m.is_preorder) || matches[0];

            return {
                found: true,
                status: statusMsg,
                quantity: best.quantity,
                in_stock: best.in_stock,
                is_preorder: best.is_preorder,
                matches: matches.slice(0, 9),
            };
        });

        console.log(`[PHD] Result for "${product_name}":`, result.status);
        return res.json({
            distributor: "PHD Games",
            product_name,
            ...result,
        });

    } catch (err) {
        console.error("[PHD] Error:", err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ─── Southern Hobby search ──────────────────────────────────────────────────
app.post("/search/southernhobby", async (req, res) => {
    const { product_name, username, password } = req.body;

    if (!product_name || !username || !password) {
        return res.status(400).json({ error: "Missing product_name, username, or password" });
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

        // ── Step 1: Log in ────────────────────────────────────────────────────
        console.log(`[SOUTHERNHOBBY] Logging in as ${username}...`);
        await page.goto("https://www.southernhobby.com/login.php", { waitUntil: "domcontentloaded" });
        await page.waitForSelector('input[name="email_address"]', { timeout: 15000 });

        await page.fill('input[name="email_address"]', username);
        await page.fill('input[name="password"]', password);
        await page.click('input[name="login"]');
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { });
        await page.waitForTimeout(2000);

        const loginFailed = (await page.$('.error, .alert-danger, [class*="error"]')) !== null;
        if (loginFailed) {
            return res.status(401).json({ error: "Southern Hobby login failed — check credentials" });
        }

        // ── Step 2: Search ────────────────────────────────────────────────────
        console.log(`[SOUTHERNHOBBY] Searching for: ${product_name}`);
        await page.goto(
            `https://www.southernhobby.com/advanced_search_result.php?search_in_description=1&q=${encodeURIComponent(product_name)}`,
            { waitUntil: "domcontentloaded" }
        );
        await page.waitForTimeout(2000);

        // ── Step 3: Parse results ─────────────────────────────────────────────
        const result = await page.evaluate(() => {
            const rows = document.querySelectorAll("tr.productListing");

            if (!rows || rows.length === 0) {
                const bodyText = document.body.innerText.toLowerCase();
                if (bodyText.includes("no results") || bodyText.includes("0 products")) {
                    return { found: false, status: "Not found", quantity: 0, matches: [] };
                }
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const matches = [];

            rows.forEach((row) => {
                const cells = row.querySelectorAll("td.productListing-data");
                if (cells.length < 6) return;

                // Cell order: image, name+link, SKU, release date, ship date, price, qty input
                const nameLinkEl = cells[1] ? cells[1].querySelector("a") : null;
                if (!nameLinkEl) return;
                const name = nameLinkEl.innerText.trim();
                const href = nameLinkEl.getAttribute("href") || "";

                const sku = cells[2] ? cells[2].innerText.trim() : "";
                const releaseDate = cells[3] ? cells[3].innerText.trim() : "";
                const shipDate = cells[4] ? cells[4].innerText.trim() : "";

                // Price cell may have a struck-through original + sale price, or just one price
                let msrp = "";
                let price = "";
                if (cells[5]) {
                    const struckEl = cells[5].querySelector('span[style*="line-through"]');
                    const saleEl = cells[5].querySelector(".pr_price");
                    if (struckEl && saleEl) {
                        msrp = struckEl.innerText.trim();
                        price = saleEl.innerText.trim();
                    } else {
                        price = cells[5].innerText.trim();
                        msrp = price;
                    }
                }

                // Southern Hobby doesn't expose live qty on the search grid —
                // presence of an orderable qty input means it's purchasable
                const qtyInput = cells[6] ? cells[6].querySelector('input[type="number"]') : null;
                const inStock = qtyInput !== null; // if there's an input to order, treat as available

                matches.push({
                    name,
                    sku,
                    quantity: null, // not exposed on the search grid
                    msrp,
                    price,
                    in_stock: inStock,
                    is_preorder: releaseDate && new Date(releaseDate) > new Date(), // future release date = preorder
                    release_date: releaseDate,
                    ship_date: shipDate,
                    url: href,
                });
            });

            if (matches.length === 0) {
                return { found: false, status: "Not found", quantity: 0, matches: [] };
            }

            const productList = matches
                .slice(0, 9)
                .map((m) => {
                    const tag = m.is_preorder ? " [Preorder]" : m.in_stock ? " (Available)" : " (Unavailable)";
                    return `${m.name}${tag}`;
                })
                .join(" // ");

            let statusMsg = "";
            if (matches.length === 1) {
                const m = matches[0];
                if (m.is_preorder) {
                    statusMsg = `Preorder — ${m.name}, Release: ${m.release_date}, MSRP: ${m.msrp}, Price: ${m.price}`;
                } else if (m.in_stock) {
                    statusMsg = `Available — ${m.name}, MSRP: ${m.msrp}, Price: ${m.price}`;
                } else {
                    statusMsg = `Unavailable — ${m.name}`;
                }
            } else {
                statusMsg = `${matches.length} products found — ${productList}`;
            }

            const best = matches.find((m) => m.in_stock && !m.is_preorder) || matches[0];

            return {
                found: true,
                status: statusMsg,
                quantity: best.quantity,
                in_stock: best.in_stock,
                is_preorder: best.is_preorder,
                matches: matches.slice(0, 9),
            };
        });

        console.log(`[SOUTHERNHOBBY] Result for "${product_name}":`, result.status);
        return res.json({
            distributor: "Southern Hobby",
            product_name,
            ...result,
        });

    } catch (err) {
        console.error("[SOUTHERNHOBBY] Error:", err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => console.log(`Vendor lookup scraper running on port ${PORT}`));