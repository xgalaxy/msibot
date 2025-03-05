import { type MerchantKind } from "./merchantBase.ts";

export type Product = {
    merchant: MerchantKind;
    url: string;
    sku: string;
    name: string;
    price: number;
    inStock: boolean;
}
