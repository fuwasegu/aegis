# Architecture Root: Next.js App Router

This project uses Next.js with the App Router and React Server Components (RSC).

## Component Model

All components are **Server Components by default**. They run on the server, can be async, and have direct access to databases, file systems, and environment variables.

Client Components are opt-in via the `'use client'` directive. They are required for interactivity (hooks, event handlers, browser APIs).

```
Server Component (default)     Client Component ('use client')
├── async/await                ├── useState, useEffect
├── Direct DB/API access       ├── onClick, onChange
├── No bundle cost             ├── Browser APIs (window, localStorage)
└── Cannot use hooks           └── Must receive serializable props
```

## Directives

| Directive | Scope | Purpose |
|-----------|-------|---------|
| `'use client'` | File top | Marks file as Client Component boundary |
| `'use server'` | File top or inline | Marks function as Server Action |
| `'use cache'` | File top or inline | Marks function for Next.js caching (experimental) |

## Rendering Flow

```
Request → Server Components render on server
        → HTML streamed to client
        → Client Components hydrate
        → Interactive
```

Server Components are never sent to the browser bundle. Client Components are hydrated after initial HTML delivery. Push interactivity boundaries as low as possible in the component tree.

## Key Constraints

1. **Server Components cannot use hooks or browser APIs** — add `'use client'` if needed.
2. **Client Components cannot be async** — fetch data in a Server Component parent and pass it down.
3. **Props crossing the Server→Client boundary must be JSON-serializable** — no functions (except Server Actions), no Date objects, no class instances.
4. **`params` and `searchParams` are async in Next.js 15+** — always `await` them.
5. **`cookies()` and `headers()` are async** — always `await` them.
