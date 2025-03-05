import { ChildProcess } from 'child_process';
import * as cheerio from 'cheerio';
import { type Page } from 'playwright';
import { initContext, initPage } from './play.ts';
import { getRandom, playSound } from './utils.ts';
import { Merchant } from './merchantBase.ts';
import { Filter, filterProducts } from './filter.ts';
import { Product } from './product.ts';
import { productQueue } from './queue.ts';

type PurchaseStatus = 'success' | 'error' | 'not_in_stock';

// TODO: config for email, pass, address, etc.

export class MerchantMsi extends Merchant {
    private readonly sessionFile = 'session_msi.json';
    private readonly recentlySeenDuration: number = 60 * 1000;
    private readonly recentlySeenCleanDuration: number = 20 * 60 * 1000;
    private readonly purchaseTimeout: number = 5 * 60 * 1000;
    private readonly maxAttempts: number = 5;
    private readonly filters: Filter[];

    // Track products recently attempted or successfully purchased to filter
    // out from the monitoring / queue; periodically empty
    private recentlySeenCleanTimestamp: number;
    private recentlySeen: Map<string, number> = new Map();

    private soundRefLogin: ChildProcess | null = null;
    private soundRefPurchase: ChildProcess | null = null;

    constructor(filters: Filter[]) {
        super('msi');
        this.filters = filters;
        this.monitorState = 'paused';
        this.recentlySeenCleanTimestamp = Date.now()
    }

    public async login(): Promise<boolean> {
        const context = await initContext({ headless: false }, this.sessionFile);
        const page = await initPage(context);
        try {
            this.pauseMonitor();
            await this.acceptCookies(page);
            return await this.attemptLogin(page, '<email>', '<password>')
        } catch (error) {
            console.error(`[${this.kind}] keep alive error:`, error);
            return false;
        } finally {
            await context.storageState({ path: this.sessionFile });
            await context.close();
            this.cleanRecentlySeen();
            this.unpauseMonitor();
        }
    }

    public async purchase(product: Product): Promise<boolean> {
        if (!this.recentlySeen.has(product.sku)) {
            // NOTE: Add product to recently seen first thing, but we are not
            //  preventing this function from attempting purchase multiple times.
            //  The intent is to prevent the monitor from adding it to the queue
            //  multiple times.
            console.error(`[${this.kind}] adding product to recent purchase attempts:`, product.name);
            this.recentlySeen.set(product.sku, Date.now());
        }

        const context = await initContext({ headless: false }, this.sessionFile);

        // NOTE: Setting up an inner function to help handle retrying
        //  logic as well as proper resource cleanup
        const self = this; // dumb hack
        async function innerPurchase(): Promise<boolean> {
            // Set high timeouts just in case
            const page = await initPage(context);
            page.setDefaultNavigationTimeout(self.purchaseTimeout);
            page.setDefaultTimeout(self.purchaseTimeout);

            if (!self.soundRefPurchase) {
                self.soundRefPurchase = playSound('resources/purchasing.mp3');
            }

            try {
                let result: PurchaseStatus= 'error';
                let purchaseAttempts = 0;
                while (purchaseAttempts < self.maxAttempts) {
                    result = await self.attemptPurchase(page)
                    if (result === 'error') {
                        console.warn(`[${self.kind}] issue during purchase; retrying...`);
                        purchaseAttempts++;
                        await new Promise(resolve => setTimeout(resolve, 1 * 1000));
                        continue;
                    }

                    break;
                }
                if (result === 'not_in_stock') console.warn(`[${self.kind}] product likely out of stock`);
                return result === 'success';
            } catch (error) {
                console.error(`[${self.kind}] error during purchase:`, error);
                return false;
            } finally {
                try {
                    self.soundRefPurchase?.kill();
                    self.soundRefPurchase = null;
                } catch { /* don't care */ }
            }
        }

        try {
            const cartAddUrl = 'https://us-store.msi.com/index.php?route=checkout/cart/add';
            const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            const data = `product_id=${product.sku}&quantity=1`;

            this.pauseMonitor();
            const api = await context.request.post(cartAddUrl, { headers, data, timeout: this.purchaseTimeout });
            if (!api.ok()) {
                console.error(`[${this.kind}] failed to add product to cart:`, api.statusText());
                return false;
            }

            // this will cleanup the context and page when done
            console.log(`[${this.kind}] added product to cart: ${product.name}`);
            return await innerPurchase();
        } catch (error) {
            console.error(`[${this.kind}] error adding product to cart:`, error);
            return false;
        } finally {
            await context.close();
            this.unpauseMonitor();
        }

    }

    public async monitor(): Promise<void> {
        // FIXME: wrap this crap into another function so we aren't repeating ourself
        const contextA = await initContext({ headless: true });
        const contextB = await initContext({ headless: true });
        const contextC = await initContext({ headless: true });
        const pageA = await initPage(contextA);
        const pageB = await initPage(contextB);
        const pageC = await initPage(contextC);

        const urlA = 'https://us-store.msi.com/New-Arrival/All-New-Arrival/New-Arrival-Graphic-Cards?limit=60';
        const urlB = 'https://us-store.msi.com/Graphics-Cards/NVIDIA-GPU/GeForce-RTX-50-Series?limit=60';
        const urlC = 'https://us-store.msi.com/search?search=5090&sort=p.price&order=DESC&limit=100'

        try {
            await Promise.allSettled([
                this.acceptCookies(pageA, urlA),
                this.acceptCookies(pageB, urlB),
                this.acceptCookies(pageC, urlC),
            ]);

            const timeBetweenMin = 8 * 1000;
            const timeBetweenMax = 30 * 1000;

            while (true) {
                if (this.monitorState === 'paused') {
                    await new Promise(resolve => setTimeout(resolve, 5 * 1000));
                    continue;
                } else if (this.monitorState === 'stopped')
                    break;

                // Page A
                try {
                    await pageA.waitForTimeout(getRandom(timeBetweenMin, timeBetweenMax));
                    const response = await pageA.goto(urlA, { waitUntil: 'networkidle' });
                    if (!response || !response.ok()) {
                        console.error(`[${this.kind}] bad response received`);
                    } else {
                        const products = this.getInStockProducts(await pageA.content(), 'New Arrivals | Graphics Cards');
                        if (products.length > 0) {
                            // try to purchase the best one based on filter
                            this.pauseMonitor();
                            productQueue.enqueue(products[0]);
                            continue;
                        } else console.log(`[${this.kind}] no products in stock`);
                    }
                } finally { /* ignore */ }

                // Page B
                try {
                    await pageB.waitForTimeout(getRandom(timeBetweenMin, timeBetweenMax));
                    const response = await pageB.goto(urlB, { waitUntil: 'networkidle' });
                    if (!response || !response.ok()) {
                        console.error(`[${this.kind}] bad response received`);
                    } else {
                        const products = this.getInStockProducts(await pageB.content(), 'Graphics Cards | 50 Series');
                        if (products.length > 0) {
                            // try to purchase the best one based on filter
                            this.pauseMonitor();
                            productQueue.enqueue(products[0]);
                            continue;
                        } else console.log(`[${this.kind}] no products in stock`);
                    }
                } finally { /* ignore */ }

                // Page C
                try {
                    await pageC.waitForTimeout(getRandom(timeBetweenMin, timeBetweenMax));
                    const response = await pageC.goto(urlC, { waitUntil: 'networkidle' });
                    if (!response || !response.ok()) {
                        console.error(`[${this.kind}] bad response received`);
                    } else {
                        const products = this.getInStockProducts(await pageC.content(), 'Search | 5090');
                        if (products.length > 0) {
                            // try to purchase the best one based on filter
                            this.pauseMonitor();
                            productQueue.enqueue(products[0]);
                            continue;
                        } else console.log(`[${this.kind}] no products in stock`);
                    }
                } catch { /* ignore */ }
            }
        } finally {
            await contextA.close();
            await contextB.close();
            await contextC.close();
        }
    }

    private async acceptCookies(page: Page, url: string = 'https://us-store.msi.com/'): Promise<boolean> {
        const response = await page.goto(url, { waitUntil: 'networkidle' });
        if (!response || !response.ok()) {
            console.error(`[${this.kind}] bad response received`);
            return false;
        }

        let attempts = 0;
        while (attempts < this.maxAttempts) {
            try {
                await page.waitForTimeout(getRandom());
                const dialog = page.getByRole('dialog', { name: 'Your choice regarding cookies' });
                if (await dialog.isVisible()) {
                    await dialog.getByRole('button', { name: 'Accept' }).click();
                    await page.waitForTimeout(getRandom());
                    return true;
                }
            } catch { /* probably already accepted */ }

            attempts++;
        }

        return false;
    }

    private async attemptLogin(page: Page, email: string, password: string): Promise<boolean> {
        const expectedUrl = 'https://us-store.msi.com/account-info';

        const self = this;
        async function canGoToAccount(): Promise<boolean> {
            let response = await page.goto(expectedUrl, { waitUntil: 'networkidle' });
            if (!response || !response.ok()) {
                console.error(`[${self.kind}] bad response received`);
                return false;
            }

            return page.url() === expectedUrl;
        }

        console.log(`[${this.kind}] attempting login`);

        let attempts = 0;
        while (attempts < this.maxAttempts) {
            try {
                if (await canGoToAccount()) {
                    console.log(`[${this.kind}] login success`);
                    return true;
                }

                const frame = page.frame({ url: /.*account.msi.com.*/ });
                if (!frame) {
                    console.error(`[${this.kind}] desired login frame not found, but found these frames:`);
                    for (const frame of page.frames())
                        console.error(`[${this.kind}]   - name: ${frame.name()} url: ${frame.url()}`);
                    throw new Error(`[${this.kind}] unable to find desired login frame`)
                }

                if (!this.soundRefLogin) {
                    this.soundRefLogin = playSound('resources/login.mp3');
                }

                await frame.getByRole('textbox', { name: 'Email' }).fill(email);
                await frame.getByRole('textbox', { name: 'Password' }).fill(password);

                const captcha = frame.getByRole('textbox', { name: 'Calculate to get the answer' })
                await page.waitForTimeout(getRandom());
                if (await captcha.isVisible()) {
                    const input = new Promise<string>(resolve => {
                        process.stdin.once('data', data => resolve(data.toString().trim()))
                    });

                    await captcha.click();
                    await captcha.fill(await input);
                    await page.waitForTimeout(getRandom());
                }

                // They are trying to be tricky
                const loginUrls = [
                    'https://account.msi.com/en/login',
                    'https://account.msi.com/en/third_part/login',
                    'https://account.msi.com/en/members/accountOverview?event=login'
                ];

                const submitResponse = page.waitForResponse(r => loginUrls.includes(r.url()));
                await frame.getByRole('button', { name: /.*(Login|Sign In).*/i }).click();
                try {
                    await submitResponse;
                    await frame.waitForURL(expectedUrl);
                } catch { /* the site sometimes fails to load */ }

                if (await canGoToAccount()) {
                    console.log(`[${this.kind}] login success`);
                    try {
                        this.soundRefLogin?.kill();
                        this.soundRefLogin = null;
                    } catch { /* don't care */ }

                    return true;
                }
            } catch { /* will retry */ };

            attempts++;
            await page.waitForTimeout(getRandom());
        }

        console.error(`[${self.kind}] failed to login over multiple attempts`);
        return false;
    }

    private async attemptPurchase(page: Page): Promise<PurchaseStatus> {
        try {
            const response = await page.goto('https://us-store.msi.com/checkout', { waitUntil: 'networkidle' });
            if (!response || !response.ok()) {
                console.warn(`[${this.kind}] bad response received`);
                return 'error';
            }

            // Check for redirect back to cart, that likely means
            // the product is out of stock, so give up.
            if (page.url() === 'https://us-store.msi.com/cart') {
                return 'not_in_stock';
            }

            console.log(`[${this.kind}] attempting purchase:`);

            // shipping location
            console.log(`[${this.kind}]   - filling shipping address...`);
            await page.waitForTimeout(200);
            await page.getByRole('textbox', { name: 'First Name' }).fill('<first>');
            await page.getByRole('textbox', { name: 'Last Name' }).fill('<last>');
            await page.getByRole('textbox', { name: 'Address Line 1' }).fill('<street>');
            await page.getByRole('textbox', { name: 'City' }).fill('<city>');
            await page.getByLabel('State').selectOption({ label: '<state>' });
            await page.getByRole('textbox', { name: 'Zip Code' }).fill('<zip>');
            await page.getByRole('textbox', { name: 'Phone Number' }).fill('<phone>');
            await page.getByRole('checkbox', { name: 'This is a residential area.' }).check();

            const addressSaveUrl = 'https://us-store.msi.com/index.php?route=checkout/shipping_address/save';
            const shipMethodUrl = 'https://us-store.msi.com/index.php?route=checkout/shipping_method';
            const shipAddressSaveResponse = page.waitForResponse(addressSaveUrl);
            const shipMethodLoadResponse = page.waitForResponse(shipMethodUrl);
            await page.locator('#button-shipping-address').click();
            try {
                await shipAddressSaveResponse;
                await shipMethodLoadResponse;
            } catch {
                console.warn(`[${this.kind}]   - failed to proceed to shipping method`);
                return 'error';
            }

            // shipping method
            console.log(`[${this.kind}]   - filling shipping method...`);
            await page.waitForTimeout(200);
            await page.getByText(/.*FedEx Home Delivery.*/).click();

            const shipMethodSaveUrl = 'https://us-store.msi.com/index.php?route=checkout/shipping_method/save';
            const billAddressUrl = 'https://us-store.msi.com/index.php?route=checkout/payment_address';
            const shipMethodSaveResponse = page.waitForResponse(shipMethodSaveUrl);
            const billAddressLoadResponse = page.waitForResponse(billAddressUrl);
            await page.locator('#button-shipping-method').click();
            try {
                await shipMethodSaveResponse;
                await billAddressLoadResponse;
            } catch {
                console.warn(`[${this.kind}]   - failed to proceed to billing address`);
                return 'error';
            }

            // billing address
            console.log(`[${this.kind}]   - filling billing address...`);
            await page.waitForTimeout(200);
            await page.getByRole('checkbox', { name: 'USE MY DELIVERY ADDRESS' }).check();

            const billAddressSaveUrl = 'https://us-store.msi.com/index.php?route=checkout/payment_address/save';
            const billMethodUrl = 'https://us-store.msi.com/index.php?route=checkout/payment_method';
            const billAddressSaveResponse = page.waitForResponse(billAddressSaveUrl);
            const billMethodLoadResponse = page.waitForResponse(billMethodUrl);
            await page.locator('#button-payment-address').click();
            try {
                await billAddressSaveResponse;
                await billMethodLoadResponse;
            } catch {
                console.warn(`[${this.kind}]   - failed to proceed to billing method`);
                return 'error';
            }

            // payment method
            console.log(`[${this.kind}]   - filling billing method...`);
            await page.waitForTimeout(200);
            let frame = page.locator('iframe[name="braintree-hosted-field-cardholderName"]').contentFrame();
            await frame.getByRole('textbox', { name: 'Cardholder Name' }).fill('<full name>');
            frame = page.locator('iframe[name="braintree-hosted-field-number"]').contentFrame();
            await frame.getByRole('textbox', { name: 'Credit Card Number' }).fill('<ccn>');
            frame = page.locator('iframe[name="braintree-hosted-field-expirationDate"]').contentFrame();
            await frame.getByRole('textbox', { name: 'Expiration Date' }).fill('<date>');
            frame = page.locator('iframe[name="braintree-hosted-field-cvv"]').contentFrame();
            await frame.getByRole('textbox', { name: 'CVV' }).fill('<cvv>');

            // Press submit
            await page.waitForTimeout(200);
            await page.getByRole('button', { name: 'Pay Now' }).click();

            // Pause here for 10 minutes, we think we are succesful but we might
            // get a captcha challenge before credit card goes through and we
            // don't want the page and context to get cleaned up during...
            await page.waitForTimeout(10 * 60 * 1000);

            return 'success';
        } catch (error) {
            console.error(`[${this.kind}] unknown error during purchasing:`, error);
            return 'error';
        }
    }

    private cleanRecentlySeen() {
        const now = Date.now();
        const timeSinceLastClean = now - this.recentlySeenCleanTimestamp;
        if (timeSinceLastClean >= this.recentlySeenDuration) {
            const someTimeAgo = now - this.recentlySeenCleanDuration;
            for (const [sku, timestamp] of this.recentlySeen.entries()) {
                if (timestamp <= someTimeAgo) {
                    this.recentlySeen.delete(sku);
                }
            }
        }

        this.recentlySeenCleanTimestamp = now;
    }

    private getInStockProducts(html: string, name:string): Product[] {
        console.log(`[${this.kind}] scanning ${name}`);

        const $ = cheerio.load(html);
        const container = $('#product-list').length
            ? $('#product-list .product-thumb')
            : $('#content .product-thumb');

        const products: Product[] = [];
        container.each((_, element) => {
            const hrefUrl = $(element).find('div[class*="select_item"] a.title').attr('href');
            const scriptContent = $(element).find('script').html();
            const inStock = $(element)
                .find('div.button button')
                .toArray()
                .some(button => $(button).text().trim().toUpperCase() === 'ADD TO CART');

            const gtagDataMatch = scriptContent?.match(/gtag\('event', 'select_item', ({.*?})\);/s);
            if (gtagDataMatch) {
                const dataString = gtagDataMatch[1]
                    .replace(/'/g, '"') // replace single quote with double
                    .replace(/(\w+)\s*:/g, '"$1":'); // wrap keys in double quotes

                const data = JSON.parse(dataString);
                const sku = data.items[0].item_id.match(/\d+/)?.[0];
                const name = data.items[0].item_name;
                const price = parseFloat(data.items[0].price);

                if (hrefUrl && sku && name && !isNaN(price)) {
                    const url = new URL(hrefUrl);
                    const baseUrl = `${url.origin}${url.pathname}`;
                    products.push({ merchant: 'msi', url: baseUrl, sku, name, price, inStock });
                } else {
                    console.warn(`[${this.kind}] skipping product due to incomplete data:`,
                        { hrefUrl, sku, name, price });
                }
            } else {
                console.warn(`[${this.kind}] unable to parse gtag data`);
            }
        });

        // First, filter out products that don't match our regex filters
        const filteredProducts = filterProducts(products, this.filters)

        // Second, filter out products that we've recently tried to purchase
        const unseenProducts = filteredProducts.filter(product => !this.recentlySeen.has(product.sku));
        const numRecentlyTried = filteredProducts.length - unseenProducts.length;
        console.log(`[${this.kind}] found ${unseenProducts.length} desired products`);

        // Finally, of those left, return the in stock ones
        return unseenProducts.filter(product => product.inStock);
    }
}
