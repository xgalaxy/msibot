import * as fs from 'fs/promises';
import { chromium } from 'playwright-extra';
import { type BrowserContext, type Page, type Browser, type LaunchOptions, Locator } from 'playwright';
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright';
import UserAgent from 'user-agents';

export async function initContext(options?: LaunchOptions, sessionFile?: string): Promise<BrowserContext> {

    let storageState: any = undefined;
    if (sessionFile) {
        try {
            await fs.access(sessionFile);
            storageState = sessionFile;
        } catch { /* probably not saved yet */ }
    }

    const userAgent = new UserAgent({ deviceCategory: 'desktop' });
    const contextOptions = {
        locale: 'en-US',
        userAgent: userAgent.toString(),
        timezoneId: 'America/Los_Angeles', // TODO randomize USA location
        storageState,
    }

    const browser = await chromium.launch(options);
    return browser.newContext(contextOptions);
}

export async function initPage(context: BrowserContext, allowCaching: boolean = true): Promise<Page> {
    const page = await context.newPage();
    PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch).then((blocker) => {
        blocker.enableBlockingInPage(page);
    });

    if (!allowCaching) {
        await page.route('**/*', (route) => {
            const headers = {
                ...route.request().headers(),
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            };
            route.continue({ headers });
        });

        await page.evaluate(() => {
            if (navigator.serviceWorker) {
                navigator.serviceWorker.getRegistrations().then((regs) => {
                    regs.forEach((reg) => reg.unregister());
                }).catch(() => {});
            }
        });
    }

    return page;
}

export async function gatherVisibleLinks(page: Page, targetPath: string): Promise<Locator[]> {
    let links = await page.locator('a:visible').all();
    return (await Promise.all(
        links.map(async link => {
            const href = await link.getAttribute('href');
            const target = await link.getAttribute('target');
            const rel = await link.getAttribute('rel');

            if (!href || !href.includes(targetPath)) return null;
            if (target === '_blank' || (rel && rel.includes('noopener') || rel?.includes('noreferrer'))) {
                return null;
            }

            return href && href.includes(targetPath) ? link : null;
        })
    )).filter(Boolean) as Locator[];
}
