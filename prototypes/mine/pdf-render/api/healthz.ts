import { json } from './_model'

export function GET(): Response {
  return json({ status: 'ok' })
}
