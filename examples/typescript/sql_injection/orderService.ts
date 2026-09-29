import { OrderQuery, query } from './db'

export interface OrderFilter {
  customer: string
  status: string
}

export function findOrders(filter: OrderFilter) {
  const where = `customer = '${filter.customer}' AND status = '${filter.status}'`
  return query(new OrderQuery(where))
}

export function countOrders(filter: OrderFilter) {
  return query(new OrderQuery(`customer = '${filter.customer}'`))
}
