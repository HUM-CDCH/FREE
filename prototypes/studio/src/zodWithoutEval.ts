import { config } from 'zod'

// The app shell's Content-Security-Policy refuses eval (server/contentSecurityPolicy.ts). Zod otherwise probes for it
// with `new Function('')` when it builds its first object schema, and the refused probe is itself a policy violation.
// main.tsx imports this module first, because schemas are built while their modules are evaluated.
config({ jitless: true })
