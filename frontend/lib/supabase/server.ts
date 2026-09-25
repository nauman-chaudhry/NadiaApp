import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * The current user's access token, for server components calling the API
 * (which verifies it against Supabase itself, so an unverified cookie read is
 * fine here). Undefined when logged out — the API then answers 401 and the
 * middleware has already redirected to /login anyway.
 */
export async function getAccessToken(): Promise<string | undefined> {
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? undefined;
}

export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(toSet) {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options));
          } catch {
            // setAll called from a Server Component — safe to ignore,
            // middleware will refresh the session.
          }
        },
      },
    },
  );
}
