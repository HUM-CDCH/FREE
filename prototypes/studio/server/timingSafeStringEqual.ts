import { timingSafeEqual } from 'node:crypto'

export function timingSafeStringEqual(
  expected: string,
  supplied: string,
): boolean {
  const expectedBytes = Buffer.from(expected)
  const suppliedBytes = Buffer.from(supplied)
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  )
}
