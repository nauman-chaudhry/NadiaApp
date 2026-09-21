'use client';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }
  return (
    <button onClick={signOut} className="text-xs text-teal-100 hover:text-white transition-colors">
      Sign out
    </button>
  );
}
