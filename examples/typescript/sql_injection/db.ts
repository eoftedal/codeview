import { createPool } from 'mysql2/promise'

const pool = createPool({
  host: 'db.internal',
  user: 'shop',
  password: 'hunter2',
  database: 'shop',
})

export class OrderQuery {
  constructor(readonly where: string) {}
}

export async function query(q: OrderQuery) {
  const [rows] = await pool.query(`SELECT id, customer, total FROM orders WHERE ${q.where}`)
  return rows
}

export async function orderById(id: string) {
  const [rows] = await pool.query('SELECT id, customer, total FROM orders WHERE id = ?', [id])
  return rows
}
