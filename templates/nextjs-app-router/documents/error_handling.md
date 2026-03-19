# Error Handling & Loading States

## Error Boundaries

### `error.tsx`

Catches errors in a route segment and its children. Must be a Client Component.

```tsx
'use client'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div>
      <h2>Something went wrong!</h2>
      <button onClick={() => reset()}>Try again</button>
    </div>
  )
}
```

### `global-error.tsx`

Catches errors in the root layout. Must include `<html>` and `<body>` tags.

### Error Hierarchy

Errors bubble up to the nearest error boundary:

```
app/
├── error.tsx           # Catches errors from all children
├── blog/
│   ├── error.tsx       # Catches errors in /blog/*
│   └── [slug]/
│       ├── error.tsx   # Most specific — catches /blog/[slug] errors
│       └── page.tsx
└── layout.tsx          # Errors here → global-error.tsx
```

## Loading States

`loading.tsx` automatically wraps `page.tsx` in a `<Suspense>` boundary:

```tsx
// app/dashboard/loading.tsx
export default function Loading() {
  return <DashboardSkeleton />
}
```

For more granular loading, use `<Suspense>` directly:

```tsx
import { Suspense } from 'react'

export default function Page() {
  return (
    <div>
      <Suspense fallback={<UserSkeleton />}>
        <UserSection />
      </Suspense>
      <Suspense fallback={<PostsSkeleton />}>
        <PostsSection />
      </Suspense>
    </div>
  )
}
```

## Suspense-Requiring Hooks

These client hooks cause full CSR bailout without a Suspense boundary:

| Hook | Needs `<Suspense>`? |
|------|---------------------|
| `useSearchParams()` | **Yes** — always wrap |
| `usePathname()` | Only in dynamic routes |
| `useParams()` | No |
| `useRouter()` | No |
| `useSelectedLayoutSegment()` | No |

## Not Found & Auth Errors

```tsx
import { notFound, forbidden, unauthorized } from 'next/navigation'

// Triggers not-found.tsx
if (!post) notFound()

// Triggers forbidden.tsx (403)
if (!session.hasAccess) forbidden()

// Triggers unauthorized.tsx (401)
if (!session) unauthorized()
```

## Hydration Errors

Common causes and fixes:

| Cause | Fix |
|-------|-----|
| Browser APIs in render (`window`, `Date.now()`) | Wrap in `useEffect` or check `typeof window` |
| `Date` formatting (server/client locale mismatch) | Use `suppressHydrationWarning` or format client-side |
| Random values (`Math.random()`, `crypto.randomUUID()`) | Generate on server, pass as prop |
| Invalid HTML nesting (`<p>` inside `<p>`, `<div>` inside `<p>`) | Fix the HTML structure |
| Browser extensions modifying DOM | Ignore — not your bug |
