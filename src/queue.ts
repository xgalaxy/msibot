import Queue from 'queue-fifo';
import { type Product } from './product.ts';

export const productQueue = new Queue<Product>();
