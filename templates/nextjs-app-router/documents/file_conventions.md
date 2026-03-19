# File Conventions & Routing

Next.js App Router uses file-based routing with special file conventions.

## Special Files

| File | Purpose | Notes |
|------|---------|-------|
| `page.tsx` | UI for a route segment | Required to make a route publicly accessible |
| `layout.tsx` | Shared UI for segment and children | Persists across navigations, does not re-render |
| `loading.tsx` | Loading UI (wraps page in Suspense) | |
| `error.tsx` | Error boundary for segment | Must be a Client Component |
| `not-found.tsx` | 404 UI for segment | |
| `global-error.tsx` | Root-level error boundary | Must include `<html>` and `<body>` |
| `route.ts` | API endpoint (Route Handler) | Cannot coexist with `page.tsx` in same segment |
| `template.tsx` | Like layout but re-renders on navigation | |
| `default.tsx` | Fallback for parallel routes | Required for parallel route slots |

## Route Segments

```
app/
├── blog/               # Static segment: /blog
├── [slug]/             # Dynamic segment: /:slug
├── [...slug]/          # Catch-all: /a/b/c
├── [[...slug]]/        # Optional catch-all: / or /a/b/c
└── (marketing)/        # Route group (ignored in URL)
```

## Parallel Routes

Named slots with `@` prefix. Layout receives slots as props.

```
app/
├── @analytics/
│   ├── page.tsx
│   └── default.tsx     # Required fallback
├── @sidebar/
│   ├── page.tsx
│   └── default.tsx     # Required fallback
└── layout.tsx          # Receives { analytics, sidebar } as props
```

Every parallel route slot must have a `default.tsx` — without it, unmatched slots cause 404s on soft navigation.

## Intercepting Routes

```
(.)   — same level
(..)  — one level up
(..)(..） — two levels up
(...) — from root
```

## Private Folders

Prefix with `_` to exclude from routing:

```
app/
├── _components/        # Private — not a route
│   └── Button.tsx
└── page.tsx
```

## Async Params (Next.js 15+)

`params` and `searchParams` are Promises — always await them:

```tsx
type Props = { params: Promise<{ slug: string }> }

export default async function Page({ params }: Props) {
  const { slug } = await params
}
```

For synchronous components, use `React.use()`:

```tsx
import { use } from 'react'

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params)
}
```

Same applies to `cookies()` and `headers()` — they are async and must be awaited.
