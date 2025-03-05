import { productQueue } from './queue.ts';
import { Merchant } from './merchantBase.ts';
import { getRandom } from './utils.ts';

export class Session {
    private readonly keepAliveDuration: number = 1 * 60 * 60 * 1000;
    private readonly merchant: Merchant;
    private stop: boolean = false;
    private keepAliveTimestamp: number;
    private isSessionValid: boolean = false;
    private monitorPromise: Promise<void> | null = null;

    constructor(merchant: Merchant) {
        this.merchant = merchant;
        this.keepAliveTimestamp = Date.now() - this.keepAliveDuration;
    }

    public async startSession() {
        console.log(`[${this.merchant.kind}] starting session`);
        this.monitorPromise = this.merchant.monitor();

        while (!this.stop) {
            await this.tryKeepAlive();
            const product = productQueue.peek();
            const canProcess = product != null && product.merchant === this.merchant.kind;
            if (this.isSessionValid && canProcess) {
                console.log(`[${this.merchant.kind}] product in stock; processing: ${product.name}`);
                const didPurchase = await this.merchant.purchase(product);
                if (didPurchase) {
                    console.log(`[${this.merchant.kind}] purchase successful: ${product.name}`);
                }
                else {
                    console.warn(`[${this.merchant.kind}] purchase failed: ${product.name}`);
                }

                // remove the product from the queue regardless if purchase was successful
                // as its likely too late to retry as other users swarm the product, also
                // the product could have been out of stock
                productQueue.dequeue()
            } else {
                if (canProcess) {
                    // we can process it but session was invalid, lets put this product
                    // back to the end of the queue to reprocess with a valid session
                    const product = productQueue.dequeue();
                    if (product) {
                        productQueue.enqueue(product);
                    }
                }
            }

            // don't spin wait so much
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    public async stopSession() {
        if (!this.stop) {
            console.log(`[${this.merchant.kind}] stopping session...`);

            this.stop = true;
            this.merchant.stopMonitor();
            await Promise.allSettled([this.monitorPromise]);
        }
    }

    private async tryKeepAlive() {
        const now = Date.now();
        const timeSince = now - this.keepAliveTimestamp;
        if (timeSince >= this.keepAliveDuration) {
            this.isSessionValid = await this.merchant.login();
            if (this.isSessionValid) {
                this.keepAliveTimestamp = Date.now();
            } else {
                console.warn(`[${this.merchant.kind}] session restore failed; will retry`);
            }
        }
    }
}
