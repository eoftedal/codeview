import express from 'express'
import { readAvatar } from './storage'
import { exportReport } from './shell'
import { hashPassword, issueToken, currentUser } from './auth'

const app = express()
app.use(express.json())

app.get('/avatar', (req, res) => {
  const name = req.query.name as string
  res.type('image/png').send(readAvatar(name))
})

app.post('/reports', async (req, res) => {
  const report = await exportReport(req.body.name)
  res.json({ report })
})

app.get('/invoices/:id', async (req, res) => {
  const invoice = await loadInvoice(req.params.id)
  res.json(invoice)
})

app.get('/login/done', (req, res) => {
  res.redirect((req.query.next as string) ?? '/')
})

app.post('/login', (req, res) => {
  const hash = hashPassword(req.body.password)
  if (hash !== lookupHash(req.body.user)) return res.status(401).end()
  res.json({ token: issueToken(req.body.user) })
})

app.get('/me', (req, res) => {
  res.json(currentUser(req.headers.authorization ?? ''))
})

declare function loadInvoice(id: string): Promise<unknown>
declare function lookupHash(user: string): string

app.listen(3000)
