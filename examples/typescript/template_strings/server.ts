import express, { Request, Response } from 'express'
import { getProductById, productIdSchema } from './db'

const app = express()

app.get('/product/:id', (req: Request, res: Response) => {
  try {
    const productId = productIdSchema.parse(req.params.id)
    const row = getProductById(productId)
    if (row === undefined) {
      return res.status(404).json({ error: 'Product not found' })
    }
    return res.send(row.name)
  } catch (e) {
    console.log(e)
    return res.status(500).end('Internal error')
  }
})

app.listen(3000)
