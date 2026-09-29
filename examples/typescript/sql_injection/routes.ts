import { Router } from 'express'
import { findOrders } from './orderService'

export const router = Router()

router.get('/orders', async (req, res) => {
  const customer = req.query.customer as string
  const status = (req.query.status as string) ?? 'open'
  const rows = await findOrders({ customer, status })
  res.json(rows)
})

router.get('/orders/search', async (req, res) => {
  const rows = await findOrders({ customer: req.body.customer, status: 'any' })
  res.json(rows)
})
