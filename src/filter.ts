import { type Product } from './product.ts';

export type Filter = {
    pattern?: RegExp;
    minPrice?: number;
    maxPrice?: number;
    rank: number;
}

export function filterProducts(products: Product[], filters: Filter[]): Product[] {
    if (filters.length === 0) {
        return products;
    }

    return products
        .map(p => {
            const matchedFilters = filters.filter(f =>
                f.pattern?.test(p.name) &&
                p.price >= (f.minPrice ?? 0) &&
                p.price <= (f.maxPrice ?? Number.MAX_VALUE)
            );

            if (matchedFilters.length === 0) {
                return null;
            }

            const bestRank = Math.max(...matchedFilters.map(f => f.rank));
            return { p, rank: bestRank };
        })
        .filter(Boolean)
        .sort((a, b) => {
            // first sort by rank descending
            if (b!.rank !== a!.rank) {
                return b!.rank - a!.rank
            }
            // then by price ascending
            return a!.p.price - b!.p.price;
        })
        .map(e => e!.p);
}
