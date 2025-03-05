import { type Product } from './product.ts';

export type MerchantKind = 'msi';
type MonitorState = 'running' | 'paused' | 'stopped';

export abstract class Merchant {
    public readonly kind: string
    protected monitorState: MonitorState;

    constructor(kind: MerchantKind) {
        this.kind = kind;
        this.monitorState = 'running';
    }

    public abstract login(): Promise<boolean>;
    public abstract purchase(product: Product): Promise<boolean>;
    public abstract monitor(): Promise<void>;

    public stopMonitor() {
        console.log(`[${this.kind}] monitor stopped`);
        this.monitorState = 'stopped';
    }

    public pauseMonitor() {
        if (this.monitorState === 'running') {
            this.monitorState = 'paused';
            console.log(`[${this.kind}] monitor paused`);
        }
    }

    public unpauseMonitor() {
        if (this.monitorState === 'paused') {
            console.log(`[${this.kind}] monitor unpaused`);
            this.monitorState = 'running';
        }
    }
}
