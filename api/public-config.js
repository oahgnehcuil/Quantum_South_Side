/* ==========================================================================
   api/public-config.js — tells the browser which Supabase project to use (Vercel serverless function).

   It reads two environment variables and returns ONLY those two values (the anon key is
   meant to be public; Row Level Security protects the data). It never returns the
   service-role key or any other variable. If either is missing, accounts stay switched off.
   ========================================================================== */

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = clean(process.env.SUPABASE_URL);
  const supabaseAnonKey = clean(process.env.SUPABASE_ANON_KEY);
  if (!supabaseUrl || !supabaseAnonKey) return res.status(200).json({ configured: false });
  return res.status(200).json({ configured: true, supabaseUrl, supabaseAnonKey });
}
