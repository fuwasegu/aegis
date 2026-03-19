# Data Fetching Patterns

## Decision Tree

```
Need to fetch data?
├── Server Component read?        → Fetch directly (no API needed)
├── Client Component mutation?    → Server Action
├── Client Component read?        → Pass from Server Component parent
├── External API / webhooks?      → Route Handler
└── REST API for mobile/external? → Route Handler
```

## Pattern 1: Server Components (Reads)

Fetch data directly — no API layer needed.

```tsx
// app/users/page.tsx (Server Component)
export default async function UsersPage() {
  const users = await db.user.findMany()
  return <ul>{users.map(u => <li key={u.id}>{u.name}</li>)}</ul>
}
```

Benefits: no API to maintain, no client-server waterfall, secrets stay on server, direct DB access.

## Pattern 2: Server Actions (Mutations)

```tsx
// app/actions.ts
'use server'
import { revalidatePath } from 'next/cache'

export async function createPost(formData: FormData) {
  await db.post.create({ data: { title: formData.get('title') as string } })
  revalidatePath('/posts')
}
```

Constraints: POST only, internal use only, cannot return non-serializable data.

**Navigation API gotcha**: `redirect()`, `notFound()`, `forbidden()`, `unauthorized()` throw special errors. Do NOT wrap them in try-catch.

```tsx
// ❌ Bad: redirect throw is caught
async function createPost(formData: FormData) {
  try {
    const post = await db.post.create({ ... })
    redirect(`/posts/${post.id}`)  // Throws!
  } catch (error) {
    return { error: 'Failed' }  // Catches the redirect!
  }
}

// ✅ Good: redirect outside try-catch
async function createPost(formData: FormData) {
  let post
  try {
    post = await db.post.create({ ... })
  } catch (error) {
    return { error: 'Failed' }
  }
  redirect(`/posts/${post.id}`)
}
```

## Pattern 3: Route Handlers (APIs)

```tsx
// app/api/posts/route.ts
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const posts = await db.post.findMany()
  return NextResponse.json(posts)
}
```

Use for: external API access, webhooks, GET endpoints needing HTTP caching, OpenAPI documentation.
Do NOT use for: internal data fetching (use Server Components) or UI mutations (use Server Actions).

## Avoiding Data Waterfalls

```tsx
// ❌ Sequential
const user = await getUser()
const posts = await getPosts()

// ✅ Parallel with Promise.all
const [user, posts] = await Promise.all([getUser(), getPosts()])

// ✅ Streaming with Suspense
<Suspense fallback={<UserSkeleton />}>
  <UserSection />
</Suspense>
<Suspense fallback={<PostsSkeleton />}>
  <PostsSection />
</Suspense>
```

## Quick Reference

| Pattern | Use Case | HTTP Method | Caching |
|---------|----------|-------------|---------|
| Server Component fetch | Internal reads | Any | Full Next.js caching |
| Server Action | Mutations, form submissions | POST only | No |
| Route Handler | External APIs, webhooks | Any | GET can be cached |
| Client fetch to API | Client-side reads | Any | HTTP cache headers |
