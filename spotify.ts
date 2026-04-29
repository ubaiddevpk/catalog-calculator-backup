


// supabase/functions/spotify/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// ── Spotify Token ────────────────────────────────────────────────────────────
async function getSpotifyToken(): Promise<string> {
  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing Spotify credentials");

  const auth = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error("Failed to get Spotify token");
  return data.access_token;
}

// ── Safe Fetch (never crashes on non-JSON) ───────────────────────────────────
async function safeFetch(url: string, options: RequestInit): Promise<any> {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[Spotify] Non-JSON response from ${url}:`, text.slice(0, 200));
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatNumber(num: number): string {
  if (!num) return "0";
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

function formatDuration(ms: number): string {
  if (!ms) return "0:00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// ── Main Server ──────────────────────────────────────────────────────────────
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // GET — health check
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        message: "Spotify Artist Function",
        usage: 'POST with { "query": "Taylor Swift" }',
        status: "ready",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // ── Parse body ────────────────────────────────────────────────────────
    let query: string | undefined;
    try {
      const body = await req.json();
      query = body.query;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body", hint: 'Send: { "query": "artist name" }' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!query?.trim()) {
      return new Response(
        JSON.stringify({ error: "Search query is required", example: { query: "Taylor Swift" } }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Get Spotify token ─────────────────────────────────────────────────
    const token = await getSpotifyToken();
    const authHeader = { Authorization: `Bearer ${token}` };

    console.log(`[Spotify] Searching for: ${query}`);

    // ── Step 1: Search artist ─────────────────────────────────────────────
    const searchData = await safeFetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=artist&limit=1`,
      { headers: authHeader }
    );

    const artist = searchData?.artists?.items?.[0];

    if (!artist) {
      return new Response(
        JSON.stringify({ error: "Artist not found on Spotify" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const artistId = artist.id;
    console.log(`[Spotify] Found: ${artist.name} (${artistId})`);

    // ── Step 2: All parallel Spotify calls ────────────────────────────────
    const [
      fullArtist,
      topTracksData,
      albumsRes,
      singlesRes,
      relatedData,
    ] = await Promise.all([

      // Full artist (genres, followers, images, popularity)
      safeFetch(
        `https://api.spotify.com/v1/artists/${artistId}`,
        { headers: authHeader }
      ),

      // Top 10 tracks with album images
      safeFetch(
        `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
        { headers: authHeader }
      ),

      // Albums — direct from Spotify (images always returned ✅)
      safeFetch(
        `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album&limit=20&market=US`,
        { headers: authHeader }
      ),

      // Singles — direct from Spotify (images always returned ✅)
      safeFetch(
        `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=single&limit=20&market=US`,
        { headers: authHeader }
      ),

      // Related artists ✅ (NOT deprecated — confirmed in Spotify docs)
      safeFetch(
        `https://api.spotify.com/v1/artists/${artistId}/related-artists`,
        { headers: authHeader }
      ),
    ]);

    // ── Step 3: Map top tracks ────────────────────────────────────────────
    const topTracks = (topTracksData?.tracks || []).slice(0, 10).map((t: any, index: number) => ({
      id: t.id,
      rank: index + 1,
      title: t.name,
      album: t.album?.name || null,
      albumImage: t.album?.images?.[0]?.url || null,   // ✅ from Spotify directly
      releaseYear: t.album?.release_date?.slice(0, 4) || null,
      releaseDate: t.album?.release_date || null,
      duration: t.duration_ms,
      durationFormatted: formatDuration(t.duration_ms),
      previewUrl: t.preview_url || null,
      spotifyUrl: t.external_urls?.spotify || null,
      popularity: t.popularity || 0,
      explicit: t.explicit || false,
      // Note: Spotify API does not provide stream counts
      // Stream counts are only available via Apify (beatanalytics actor)
      streamCount: null,
      streamCountFormatted: "N/A",
    }));

    // ── Step 4: Map albums ────────────────────────────────────────────────
    const albums = (albumsRes?.items || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      image: a.images?.[0]?.url || null,              // ✅ always has image
      releaseDate: a.release_date || null,
      releaseYear: a.release_date?.slice(0, 4) || null,
      totalTracks: a.total_tracks || 0,
      type: "album",
      spotifyUrl: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`,
    }));

    // ── Step 5: Map singles ───────────────────────────────────────────────
    const singles = (singlesRes?.items || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      image: s.images?.[0]?.url || null,              // ✅ always has image
      releaseDate: s.release_date || null,
      releaseYear: s.release_date?.slice(0, 4) || null,
      totalTracks: s.total_tracks || 0,
      type: "single",
      spotifyUrl: s.external_urls?.spotify || `https://open.spotify.com/album/${s.id}`,
    }));

    // ── Step 6: Map related artists ───────────────────────────────────────
    const relatedArtists = (relatedData?.artists || []).slice(0, 10).map((a: any) => ({
      id: a.id,
      name: a.name,
      image: a.images?.[0]?.url || null,
      genres: a.genres || [],
      followers: a.followers?.total || 0,
      followersFormatted: formatNumber(a.followers?.total),
      popularity: a.popularity || 0,
      popularityFormatted: `${a.popularity}/100`,
      spotifyUrl: a.external_urls?.spotify || null,
    }));

    // ── Step 7: Stats ─────────────────────────────────────────────────────
    const averagePopularity = topTracks.length > 0
      ? Math.round(topTracks.reduce((sum: number, t: any) => sum + t.popularity, 0) / topTracks.length)
      : 0;

    const followersRaw = fullArtist?.followers?.total || artist.followers?.total || 0;
    const artistImage = fullArtist?.images?.[0]?.url || artist.images?.[0]?.url || null;

    // ── Final response ────────────────────────────────────────────────────
    const result = {
      platform: "spotify",
      id: artistId,
      name: fullArtist?.name || artist.name,
      image: artistImage,
      images: fullArtist?.images || artist.images || [],
      followers: formatNumber(followersRaw),
      followersRaw,
      popularity: fullArtist?.popularity || 0,
      popularityFormatted: `${fullArtist?.popularity || 0}/100`,
      genres: fullArtist?.genres || [],
      spotifyUrl: fullArtist?.external_urls?.spotify || artist.external_urls?.spotify,
      verified: false, // Spotify API does not expose verified status

      topTracks,       // ✅ with album images, preview URLs
      relatedArtists,  // ✅ with images
      albums,          // ✅ with images (fetched directly from /artists/{id}/albums)
      singles,         // ✅ with images (fetched directly from /artists/{id}/albums)

      stats: {
        totalFollowers: followersRaw,
        popularity: fullArtist?.popularity || 0,
        totalGenres: (fullArtist?.genres || []).length,
        totalTopTracks: topTracks.length,
        totalRelatedArtists: relatedArtists.length,
        totalAlbums: albums.length,
        totalSingles: singles.length,
        averageTrackPopularity: averagePopularity,
        // Note: monthlyListeners and worldRank not available via Spotify API
        // Use Apify (beatanalytics) function for those
        monthlyListeners: "N/A",
        worldRank: "N/A",
        streamCounts: "N/A - use Apify function",
      },
    };

    console.log(`[Spotify] ✅ Done: ${result.name} | Tracks:${topTracks.length} Albums:${albums.length} Singles:${singles.length} Related:${relatedArtists.length}`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[Spotify] Unhandled error:", err);
    return new Response(
      JSON.stringify({
        error: err.message || "Internal server error",
        details: err.toString(),
        stack: err.stack,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
