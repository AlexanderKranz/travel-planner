import { NextResponse } from 'next/server';
import { z } from 'zod';
import { searchAirports } from '@/lib/integrations/airports';

const querySchema = z.object({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }
  const results = searchAirports(parsed.data.q, parsed.data.limit);
  return NextResponse.json(
    { results },
    { headers: { 'Cache-Control': 'public, max-age=86400' } },
  );
}
