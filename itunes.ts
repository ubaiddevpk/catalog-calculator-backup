

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ── CORS ─────────────────────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── API endpoints ─────────────────────────────────────────────────────────────
const ITUNES_SEARCH_API  = "https://itunes.apple.com/search";
const ITUNES_LOOKUP_API  = "https://itunes.apple.com/lookup";
const APPLE_MUSIC_API    = "https://api.music.apple.com/v1";

// ── MusicKit credentials (from Supabase Secrets) ─────────────────────────────
const MUSICKIT_TEAM_ID      = Deno.env.get("MUSICKIT_TEAM_ID")   ?? "";
const MUSICKIT_KEY_ID       = Deno.env.get("MUSICKIT_KEY_ID")    ?? "";
const MUSICKIT_PRIVATE_KEY  = Deno.env.get("MUSICKIT_PRIVATE_KEY");   // .p8 content

// ── Request shape ─────────────────────────────────────────────────────────────
interface SearchParams {
  query?:       string;
  artistId?:    string;
  limit?:       number;
  useMusicKit?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT generation for Apple Music API
// ─────────────────────────────────────────────────────────────────────────────

async function generateMusicKitToken(): Promise<string> {
  if (!MUSICKIT_PRIVATE_KEY) {
    throw new Error("MusicKit private key not configured");
  }

  const now       = Math.floor(Date.now() / 1000);
  const expiresAt = now + 180 * 24 * 60 * 60; // 180 days

  const header  = { alg: "ES256", kid: MUSICKIT_KEY_ID };
  const payload = { iss: MUSICKIT_TEAM_ID, iat: now, exp: expiresAt };

  const toB64Url = (str: string) =>
    btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const headerB64  = toB64Url(JSON.stringify(header));
  const payloadB64 = toB64Url(JSON.stringify(payload));
  const message    = `${headerB64}.${payloadB64}`;

  const pemKey = MUSICKIT_PRIVATE_KEY.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(pemKey), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    new TextEncoder().encode(message)
  );

  const sigB64 = toB64Url(String.fromCharCode(...new Uint8Array(signature)));
  return `${message}.${sigB64}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a 0–100 catalog score from countable API metadata.
 * No stream data or fake popularity — only what the API actually returns.
 *
 *   albums  × 5  (deep catalog = highest passive-income weight)
 *   singles × 2
 *   tracks  × 1  (volume bonus)
 */
function buildCatalogScore(totalAlbums: number, totalSingles: number, totalTracks: number): number {
  return Math.min(totalAlbums * 5 + totalSingles * 2 + totalTracks * 1, 100);
}

/**
 * Rank-to-score mapping for Apple Music chart positions.
 * Position 1 is the strongest demand signal the public API offers.
 */
function rankToScore(rank: number): number {
  if (rank <= 10)  return 100;
  if (rank <= 50)  return 70;
  if (rank <= 100) return 40;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart data — fetched ONCE per request, reused across free + premium paths
// ─────────────────────────────────────────────────────────────────────────────

interface ChartSong {
  songId:     string;
  title:      string;
  artistName: string;
  rank:       number;          // 1-based
}

/**
 * Fetch the Apple Music Top 100 Songs chart for the US storefront.
 *
 * Endpoint: GET /v1/catalog/us/charts?types=songs&limit=100
 *
 * On failure this returns an empty array — the caller handles the fallback.
 */
async function getChartData(token: string): Promise<ChartSong[]> {
  try {
    const url = new URL(`${APPLE_MUSIC_API}/catalog/us/charts`);
    url.searchParams.set("types", "songs");
    url.searchParams.set("limit", "100");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.warn(`⚠️  Charts API returned ${response.status} — chartScore will be 0`);
      return [];
    }

    const data = await response.json();

    // Response shape: { results: { songs: [ { chart, data: [...] } ] } }
    const songChart: any[] = data?.results?.songs?.[0]?.data ?? [];

    return songChart.map((item: any, index: number) => ({
      songId:     item.id,
      title:      item.attributes?.name        ?? "",
      artistName: item.attributes?.artistName  ?? "",
      rank:       index + 1,
    }));
  } catch (err) {
    console.warn("⚠️  Charts fetch failed — chartScore will be 0:", err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart ↔ artist song matching
// ─────────────────────────────────────────────────────────────────────────────

interface ChartStats {
  chartScore:       number;          // 0–100
  chartedSongs:     number;          // how many of the artist's top tracks charted
  topChartPosition: number | null;   // best (lowest) rank found, or null
}

/**
 * Match an artist's known top songs against the live chart list and produce
 * a normalised 0–100 chart score.
 *
 * Matching is deliberately lenient (lower-cased title substring + artist name
 * substring) because the iTunes free API and the MusicKit API use slightly
 * different artist-name formatting for features / collaborations.
 *
 * The score is the SUM of per-song rank scores, normalised against the
 * theoretical maximum (all songs at rank 1 = 100 each).
 */
function calculateChartScore(
  topSongTitles:   string[],   // titles from the artist's top tracks
  artistName:      string,
  chartSongs:      ChartSong[]
): ChartStats {
  if (!chartSongs.length || !topSongTitles.length) {
    return { chartScore: 0, chartedSongs: 0, topChartPosition: null };
  }

  const artistLower = artistName.toLowerCase();

  let totalScore       = 0;
  let chartedSongs     = 0;
  let topChartPosition: number | null = null;

  for (const title of topSongTitles) {
    const titleLower = title.toLowerCase();

    const match = chartSongs.find(
      (cs) =>
        cs.title.toLowerCase().includes(titleLower) &&
        cs.artistName.toLowerCase().includes(artistLower)
    );

    if (match) {
      const score = rankToScore(match.rank);
      totalScore += score;
      chartedSongs++;

      if (topChartPosition === null || match.rank < topChartPosition) {
        topChartPosition = match.rank;
      }
    }
  }

  // Normalise: if every top song scored 100, the max would be topSongs.length × 100.
  // Clamp final score to 0–100.
  const maxPossible = topSongTitles.length * 100;
  const chartScore  = maxPossible > 0
    ? Math.min(Math.round((totalScore / maxPossible) * 100), 100)
    : 0;

  return { chartScore, chartedSongs, topChartPosition };
}

/**
 * Combine catalog and chart signals into a single final score.
 *
 *   finalScore = (catalogScore × 0.6) + (chartScore × 0.4)
 *
 * Clamped to 0–100.
 */
function buildFinalScore(catalogScore: number, chartScore: number): number {
  return Math.min(Math.round(catalogScore * 0.6 + chartScore * 0.4), 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility formatters
// ─────────────────────────────────────────────────────────────────────────────

function msToTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min      = Math.floor(totalSec / 60);
  const sec      = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artist search
// ─────────────────────────────────────────────────────────────────────────────

async function searchArtistFree(query: string): Promise<any> {
  const url = new URL(ITUNES_SEARCH_API);
  url.searchParams.set("term",    query);
  url.searchParams.set("entity",  "musicArtist");
  url.searchParams.set("limit",   "10");
  url.searchParams.set("country", "US");

  const res  = await fetch(url.toString());
  const data = await res.json();

  if (!data.results?.length) throw new Error(`No artist found for: ${query}`);

  const lower      = query.toLowerCase();
  const exactMatch = data.results.find((r: any) => r.artistName?.toLowerCase() === lower);
  return exactMatch ?? data.results[0];
}

async function searchArtistPremium(query: string, token: string): Promise<any> {
  const url = new URL(`${APPLE_MUSIC_API}/catalog/us/search`);
  url.searchParams.set("term",  query);
  url.searchParams.set("types", "artists");
  url.searchParams.set("limit", "10");

  const res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();

  if (!data.results?.artists?.data?.length) throw new Error(`No artist found for: ${query}`);
  return data.results.artists.data[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Album fetchers
// ─────────────────────────────────────────────────────────────────────────────

async function getAlbumsFree(artistId: string): Promise<any[]> {
  const url = new URL(ITUNES_LOOKUP_API);
  url.searchParams.set("id",      artistId);
  url.searchParams.set("entity",  "album");
  url.searchParams.set("limit",   "200");
  url.searchParams.set("country", "US");

  const res  = await fetch(url.toString());
  const data = await res.json();

  // Include Album, Single, AND EP — let formatFreeData do the splitting
  const albums = (data.results ?? []).filter(
    (i: any) => i.wrapperType === "collection" && 
    ["Album", "Single", "EP"].includes(i.collectionType)
  );

  return Array.from(new Map(albums.map((a: any) => [a.collectionId, a])).values()).sort(
    (a: any, b: any) => new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
  );
}

async function getAlbumsPremium(artistId: string, token: string): Promise<any[]> {
  const res  = await fetch(`${APPLE_MUSIC_API}/catalog/us/artists/${artistId}/albums`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Song fetchers
// ─────────────────────────────────────────────────────────────────────────────

async function getSongsFree(artistId: string): Promise<any[]> {
  const url = new URL(ITUNES_LOOKUP_API);
  url.searchParams.set("id",      artistId);
  url.searchParams.set("entity",  "song");
  url.searchParams.set("limit",   "50");
  url.searchParams.set("country", "US");

  const res  = await fetch(url.toString());
  const data = await res.json();

  return (data.results ?? [])
    .filter((i: any) => i.wrapperType === "track" && i.kind === "song")
    .slice(0, 10);
}

async function getSongsPremium(artistId: string, token: string): Promise<any[]> {
  const res  = await fetch(`${APPLE_MUSIC_API}/catalog/us/artists/${artistId}/songs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return (data.data ?? []).slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Response formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatFreeData(
  artist:     any,
  albums:     any[],
  topSongs:   any[],
  chartStats: ChartStats,
  finalScore: number,
  catalogScore: number,
): any {
const formattedAlbums = albums.map((a: any) => ({
  id:          a.collectionId.toString(),
  name:        a.collectionName,
  releaseDate: a.releaseDate?.split("T")[0] ?? null,
  totalTracks: a.trackCount ?? 0,
  image:       a.artworkUrl100?.replace("100x100", "600x600") ?? null,
  type:        a.collectionType?.toLowerCase() ?? "album",  // "album", "single", "ep"
  genres:      a.primaryGenreName ? [a.primaryGenreName] : [],
  appleUrl:    a.collectionViewUrl,
}));

// Use the actual collectionType from Apple's API — no more guessing
const singles    = formattedAlbums.filter((a) => a.type === "single" || a.type === "ep");
const albumsOnly = formattedAlbums.filter((a) => a.type === "album");





  const formattedTopTracks = topSongs.map((s: any, i: number) => ({
    id:               s.trackId?.toString(),
    rank:             i + 1,
    title:            s.trackName,
    album:            s.collectionName,
    releaseDate:      s.releaseDate?.split("T")[0] ?? null,
    releaseYear:      s.releaseDate ? new Date(s.releaseDate).getFullYear() : null,
    duration:         s.trackTimeMillis ?? 0,
    durationFormatted: s.trackTimeMillis ? msToTimestamp(s.trackTimeMillis) : null,
    previewUrl:       s.previewUrl ?? null,
    explicit:         s.trackExplicitness === "explicit",
    appleUrl:         s.trackViewUrl,
  }));

  return buildResponseShape({
    apiMode:       "free",
    artist:        { id: artist.artistId?.toString(), name: artist.artistName, image: artist.artworkUrl100?.replace("100x100", "600x600") ?? null, genres: artist.primaryGenreName ? [artist.primaryGenreName] : [], appleUrl: artist.artistLinkUrl, biography: null },
    topTracks:     formattedTopTracks,
    albumsOnly,
    singles,
    chartStats,
    finalScore,
    catalogScore,
  });
}

function formatPremiumData(
  artist:     any,
  albums:     any[],
  topSongs:   any[],
  chartStats: ChartStats,
  finalScore: number,
  catalogScore: number,
): any {
  const attr = artist.attributes ?? {};

  const formattedAlbums = albums.map((a: any) => {
    const aa = a.attributes ?? {};
    return {
      id:          a.id,
      name:        aa.name,
      releaseDate: aa.releaseDate ?? null,
      totalTracks: aa.trackCount  ?? 0,
      image:       aa.artwork?.url?.replace("{w}", "600").replace("{h}", "600") ?? null,
      type:        aa.isSingle ? "single" : "album",
      genres:      aa.genreNames ?? [],
      appleUrl:    aa.url,
    };
  });

  const singles    = formattedAlbums.filter((a) => a.type === "single");
  const albumsOnly = formattedAlbums.filter((a) => a.type !== "single");

  const formattedTopTracks = topSongs.map((s: any, i: number) => {
    const sa = s.attributes ?? {};
    return {
      id:               s.id,
      rank:             i + 1,
      title:            sa.name,
      album:            sa.albumName,
      releaseDate:      sa.releaseDate ?? null,
      releaseYear:      sa.releaseDate ? new Date(sa.releaseDate).getFullYear() : null,
      duration:         sa.durationInMillis ?? 0,
      durationFormatted: sa.durationInMillis ? msToTimestamp(sa.durationInMillis) : null,
      previewUrl:       sa.previews?.[0]?.url ?? null,
      explicit:         sa.contentRating === "explicit",
      appleUrl:         sa.url,
    };
  });

  return buildResponseShape({
    apiMode:       "premium",
    artist:        { id: artist.id, name: attr.name, image: attr.artwork?.url?.replace("{w}", "600").replace("{h}", "600") ?? null, genres: attr.genreNames ?? [], appleUrl: attr.url, biography: attr.editorialNotes?.standard ?? null },
    topTracks:     formattedTopTracks,
    albumsOnly,
    singles,
    chartStats,
    finalScore,
    catalogScore,
  });
}

/**
 * Single canonical response shape used by both free and premium paths.
 * Having one builder keeps the contract between backend and frontend clear.
 */
function buildResponseShape({
  apiMode,
  artist,
  topTracks,
  albumsOnly,
  singles,
  chartStats,
  finalScore,
  catalogScore,
}: {
  apiMode:      string;
  artist:       { id: string; name: string; image: string | null; genres: string[]; appleUrl: string; biography: string | null };
  topTracks:    any[];
  albumsOnly:   any[];
  singles:      any[];
  chartStats:   ChartStats;
  finalScore:   number;
  catalogScore: number;
}): any {
  const totalAlbums  = albumsOnly.length;
  const totalSingles = singles.length;
  const totalTracks  = topTracks.length;

  return {
    platform:   "itunes",
    apiMode,

    // ── Artist identity ───────────────────────────────────────────────────
    id:       artist.id,
    name:     artist.name,
    image:    artist.image,
    genres:   artist.genres,
    appleUrl: artist.appleUrl,
    biography: artist.biography,

    // Fields that Apple Music does not provide — explicitly null to keep
    // the frontend contract stable (no silent undefined errors)
    followers:          null,
    followersFormatted: "N/A",
    monthlyListeners:   null,

    // ── Scoring — all signals clearly labelled ────────────────────────────
    scoring: {
      // 0–100 from catalog metadata (albums × 5 + singles × 2 + tracks × 1)
      catalogScore,
      // 0–100 from chart position matching (Apple Music Top 100)
      chartScore: chartStats.chartScore,
      // Weighted composite: catalogScore × 0.6 + chartScore × 0.4
      finalScore,
    },

    // ── Chart presence ────────────────────────────────────────────────────
    chartStats: {
      chartScore:       chartStats.chartScore,
      chartedSongs:     chartStats.chartedSongs,
      topChartPosition: chartStats.topChartPosition,
    },

    // ── Catalog ───────────────────────────────────────────────────────────
    topTracks,
    albums:          albumsOnly,
    singles,
    popularReleases: [...albumsOnly.slice(0, 3), ...singles.slice(0, 2)],

    // ── Aggregate stats ───────────────────────────────────────────────────
    stats: {
      totalTopTracks: totalTracks,
      totalAlbums,
      totalSingles,
      // Downstream components that previously read `popularity` can now use
      // scoring.finalScore instead.  These stream/view fields remain N/A
      // because Apple Music API genuinely does not expose them.
      totalStreams:    "N/A",
      averageStreams:  "N/A",
      totalSubscribers: "N/A",
      totalViews:      "N/A",
      totalVideos:     0,
    },

    relatedArtists: [],
    topCities:      [],
    externalLinks:  [{ label: "Apple Music", url: artist.appleUrl }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request handler
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { query, artistId, useMusicKit = false }: SearchParams = await req.json();

    if (!query && !artistId) {
      throw new Error("query or artistId is required");
    }

    console.log("🎵 iTunes request:", { query, artistId, useMusicKit });

    let responseData: any;

    // ── PREMIUM path (MusicKit JWT required) ──────────────────────────────
    if (useMusicKit && MUSICKIT_PRIVATE_KEY) {
      console.log("🌟 Premium path — Apple Music API + Charts");

      const token = await generateMusicKitToken();

      // Fetch artist, albums, top songs, AND chart data concurrently.
      // Chart data is fetched once here and reused for scoring — never twice.
      let artist: any;
      if (artistId) {
        const res  = await fetch(`${APPLE_MUSIC_API}/catalog/us/artists/${artistId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        artist = data.data[0];
      } else {
        artist = await searchArtistPremium(query!, token);
      }

      const [albums, topSongs, chartSongs] = await Promise.all([
        getAlbumsPremium(artist.id, token),
        getSongsPremium(artist.id, token),
        getChartData(token),   // ← single chart fetch
      ]);

      const totalAlbums  = albums.filter((a: any) => !(a.attributes?.isSingle)).length;
      const totalSingles = albums.filter((a: any) =>   a.attributes?.isSingle).length;
      const totalTracks  = topSongs.length;

      const catalogScore = buildCatalogScore(totalAlbums, totalSingles, totalTracks);
      const topSongTitles = topSongs.map((s: any) => s.attributes?.name ?? "");
      const artistName    = artist.attributes?.name ?? "";
      const chartStats    = calculateChartScore(topSongTitles, artistName, chartSongs);
      const finalScore    = buildFinalScore(catalogScore, chartStats.chartScore);

      responseData = formatPremiumData(artist, albums, topSongs, chartStats, finalScore, catalogScore);

      console.log("✅ Premium: catalogScore =", catalogScore, "| chartScore =", chartStats.chartScore, "| finalScore =", finalScore);

    // ── FREE path (iTunes Search API) ─────────────────────────────────────
    } else {
      console.log("🆓 Free path — iTunes Search API");

      // The free iTunes API has no auth requirement, so we still need a
      // MusicKit token for the Charts endpoint.  If the private key is missing,
      // charts are skipped and chartScore defaults to 0.
      let chartSongs: ChartSong[] = [];
      if (MUSICKIT_PRIVATE_KEY) {
        try {
          const token = await generateMusicKitToken();
          chartSongs  = await getChartData(token);
        } catch {
          console.warn("⚠️  Could not fetch charts for free path — chartScore will be 0");
        }
      }

      let artist: any;
      if (artistId) {
        const url = new URL(ITUNES_LOOKUP_API);
        url.searchParams.set("id", artistId);
        const res  = await fetch(url.toString());
        const data = await res.json();
        artist = data.results[0];
      } else {
        artist = await searchArtistFree(query!);
      }

      const [albums, topSongs] = await Promise.all([
        getAlbumsFree(artist.artistId.toString()),
        getSongsFree(artist.artistId.toString()),
      ]);

      // Classify albums vs singles by the same heuristic as before
    const formattedAlbums = albums.map((a: any) => ({
  trackCount:     a.trackCount ?? 0,
  name:           a.collectionName ?? "",
  collectionType: (a.collectionType ?? "album").toLowerCase(),
}));

const totalAlbums  = formattedAlbums.filter((a) => a.collectionType === "album").length;
const totalSingles = formattedAlbums.filter((a) => a.collectionType === "single" || a.collectionType === "ep").length;











      // const totalAlbums  = formattedAlbums.filter((a) => !a.name.toLowerCase().includes("single") && a.trackCount > 2).length;
      // const totalSingles = formattedAlbums.filter((a) =>  a.name.toLowerCase().includes("single") || a.trackCount <= 2).length;
      const totalTracks  = topSongs.length;

      const catalogScore  = buildCatalogScore(totalAlbums, totalSingles, totalTracks);
      const topSongTitles = topSongs.map((s: any) => s.trackName ?? "");
      const artistName    = artist.artistName ?? "";
      const chartStats    = calculateChartScore(topSongTitles, artistName, chartSongs);
      const finalScore    = buildFinalScore(catalogScore, chartStats.chartScore);

      responseData = formatFreeData(artist, albums, topSongs, chartStats, finalScore, catalogScore);

      console.log("✅ Free: catalogScore =", catalogScore, "| chartScore =", chartStats.chartScore, "| finalScore =", finalScore);
    }

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("❌ iTunes function error:", error);

    return new Response(
      JSON.stringify({
        error:   error?.message ?? "Failed to fetch from iTunes/Apple Music API",
        details: error?.toString(),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
