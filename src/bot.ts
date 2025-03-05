import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { playSound } from './utils.ts';
import { MerchantMsi } from './merchantMsi.ts';
import { type Filter } from './filter.ts';
import { Session } from './session.ts';

let isShuttingDown = false;
let sessions: Session[] = [];

async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\n[system] shutting down...');
    let shutdownSuccess = true;

    try {
        await Promise.allSettled(sessions.map(async s => await s.stopSession()));
        console.log('[system] shutdown complete')
    } catch (error) {
        console.error('[system] error during shutdown:', error);
        shutdownSuccess = false;
    } finally {
        process.exit(shutdownSuccess ? 0 : 1);
    }
}

async function main() {
    console.log('\n[system] started')
    playSound('resources/startup.mp3');

    // attempt to gracefully handle all signals for shutting down
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('uncaughtException', gracefulShutdown);
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[system] unhandled rejection at:', promise, 'reason:', reason);
        gracefulShutdown();
    });

    const msiFilters: Filter[] = [
        { pattern: /^(?=.*5090)(?=.*SUPRIM)(?!.*SUPRIM LIQUID)/i, rank: 10 },
        { pattern: /^(?=.*5090)(?=.*VANGUARD)(?=.*LAUNCH)/i, rank: 8 },
        { pattern: /^(?=.*5090)(?=.*VANGUARD)/i, rank: 6 },
        { pattern: /^(?=.*5090)(?=.*GAMING TRIO)/i, rank: 4 },
    ];

    const msiMerchant = new MerchantMsi(msiFilters);
    sessions.push(new Session(msiMerchant));

    chromium.use(stealth());
    const results = await Promise.allSettled(sessions.map(async s => await s.startSession()));
    results.forEach((result) => {
        if (result.status == 'rejected') {
            console.error('[system] error in startup tasks:', result.reason);
        }
    });

    console.log('[system] shutdown complete')
}

main();
