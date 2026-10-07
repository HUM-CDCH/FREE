import { json } from './_http.js'

export function GET(): Response {
  return json({ status: 'ok' })
}
