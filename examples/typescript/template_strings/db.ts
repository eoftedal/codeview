import Database from 'better-sqlite3'
import * as z from 'zod'

const db = new Database('shop.db')
export const productIdSchema = z.string().regex(/^\d{1,10}$/)
export type ProductId = z.infer<typeof productIdSchema>
export type Product = { id: string; name: string; price: number }

export function getProductById(productId: ProductId): Product | undefined {
  return query`SELECT id, name, price FROM Products WHERE id = ${productId}`
}

function query(strings: TemplateStringsArray, ...values: any[]) {
  return db.prepare(strings.join('?')).get(...values) as Product | undefined
}
