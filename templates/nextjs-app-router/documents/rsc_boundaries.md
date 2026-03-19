# RSC Boundaries & Directives

Rules for crossing the Server/Client Component boundary.

## Async Client Components Are Invalid

Client Components **cannot** be async. Only Server Components support async/await.

```tsx
// ❌ Bad: async client component
'use client'
export default async function UserProfile() {
  const user = await getUser()
  return <div>{user.name}</div>
}

// ✅ Good: fetch in server parent, pass data down
// page.tsx (Server Component)
export default async function Page() {
  const user = await getUser()
  return <UserProfile user={user} />
}

// UserProfile.tsx (Client Component)
'use client'
export function UserProfile({ user }: { user: User }) {
  return <div>{user.name}</div>
}
```

## Serialization Rules for Props

Props passed from Server → Client must be JSON-serializable.

| Type | Allowed? | Fix |
|------|----------|-----|
| `string`, `number`, `boolean` | ✅ Yes | — |
| Plain object / array | ✅ Yes | — |
| Server Action (`'use server'`) | ✅ Yes | — |
| Function `() => {}` | ❌ No | Define inside client component |
| `Date` object | ❌ No | Use `.toISOString()` |
| `Map`, `Set` | ❌ No | Convert to object/array |
| Class instance | ❌ No | Pass plain object |
| `Symbol`, circular refs | ❌ No | Restructure |

```tsx
// ❌ Bad: Date object (silently becomes string, crashes on methods)
<PostCard createdAt={post.createdAt} />

// ✅ Good: serialize first
<PostCard createdAt={post.createdAt.toISOString()} />
```

## Server Actions Are the Exception

Functions marked with `'use server'` CAN be passed to Client Components:

```tsx
// actions.ts
'use server'
export async function submitForm(formData: FormData) { /* ... */ }

// page.tsx (Server Component)
import { submitForm } from './actions'
export default function Page() {
  return <ClientForm onSubmit={submitForm} />  // OK
}
```

## Directive Placement

- `'use client'` goes at the **top of the file**, before any imports. It marks the entire file (and its exports) as the Client Component boundary.
- `'use server'` goes at the **top of the file** (all exports become Server Actions) or **inline in a function body** within a Server Component.
- Minimize the `'use client'` surface — extract interactive parts into small Client Components and keep parents as Server Components.
