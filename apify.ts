



// supabase/functions/apify/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

async function getSpotifyToken() {
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
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Handle GET requests for testing
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({
          message: "Apify Spotify Scraper Function",
          usage: 'Send POST request with JSON body: { "query": "Taylor Swift" }',
          status: "ready"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get request body
    let query;
    try {
      const contentType = req.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const body = await req.json();
        query = body.query;
      } else {
        const text = await req.text();
        if (text) {
          const body = JSON.parse(text);
          query = body.query;
        }
      }
    } catch (parseError) {
      return new Response(
        JSON.stringify({ 
          error: "Invalid JSON in request body",
          hint: 'Send: { "query": "artist name" }'
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    if (!query || query.trim() === "") {
      return new Response(
        JSON.stringify({ 
          error: "Search query is required",
          example: { query: "Taylor Swift" }
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN");
    
    if (!APIFY_TOKEN) {
      return new Response(
        JSON.stringify({ 
          error: "Apify token not configured",
          hint: "Add APIFY_TOKEN in Supabase Edge Function settings"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[Apify] Searching for: ${query}`);

    // Step 1: Get Spotify artist URL and ID
    const spotifyToken = await getSpotifyToken();

    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=artist&limit=1`, 
      { headers: { Authorization: `Bearer ${spotifyToken}` } }
    );
    
    const searchData = await searchRes.json();
    const artist = searchData.artists?.items?.[0];
    
    if (!artist) {
      return new Response(
        JSON.stringify({ error: "Artist not found on Spotify" }), 
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const spotifyUrl = artist.external_urls?.spotify;
    const artistId = artist.id;

    if (!spotifyUrl) {
      return new Response(
        JSON.stringify({ error: "Spotify URL not found for artist" }), 
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[Apify] Found Spotify URL: ${spotifyUrl}`);

    // Step 2: Parallel API Calls - Apify + Spotify enrichment data
    const [apifyResponse, fullArtist, relatedData] = await Promise.all([
      // Apify call
      fetch(
        `https://api.apify.com/v2/acts/beatanalytics~spotify-play-count-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: [{ url: spotifyUrl }],
            followAlbums: false,
            followSingles: false,
            followPopularReleases: false,
          }),
        }
      ),
      
      // Spotify artist details (for genres)
      fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
        headers: { Authorization: `Bearer ${spotifyToken}` },
      }).then(r => r.json()),
      
      // Spotify related artists
      fetch(`https://api.spotify.com/v1/artists/${artistId}/related-artists`, {
        headers: { Authorization: `Bearer ${spotifyToken}` },
      }).then(r => r.json()),
    ]);

    if (!apifyResponse.ok) {
      const errorText = await apifyResponse.text();
      console.error("[Apify] API error:", errorText);
      return new Response(
        JSON.stringify({ 
          error: "Failed to fetch from Apify", 
          details: errorText,
          status: apifyResponse.status
        }),
        { 
          status: apifyResponse.status, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    const apifyData = await apifyResponse.json();
    console.log(`[Apify] Received data from Apify`);

    // Step 3: Process Apify data
    if (!apifyData || apifyData.length === 0) {
      return new Response(
        JSON.stringify({ error: "No data returned from Apify" }), 
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const artistData = apifyData[0];




    // Step 4: Enrich track data with Spotify API (album, images, preview URLs)
    let topTracks = (artistData.topTracks || []).slice(0, 10);
    
    if (topTracks.length > 0) {
      try {
        const trackIds = topTracks.map((t: any) => t.id).join(',');
      const tracksResponse = await fetch(
  `https://api.spotify.com/v1/tracks?ids=${trackIds}&market=US`,
  { headers: { Authorization: `Bearer ${spotifyToken}` } }
);

// ADD THIS to see what Spotify is actually returning
const tracksRaw = await tracksResponse.text();
console.log("[Spotify tracks raw]:", tracksRaw.slice(0, 500));
const tracksData = JSON.parse(tracksRaw);
        
        // Merge Apify stream counts with Spotify track details
        topTracks = topTracks.map((track: any, index: number) => {
          const spotifyTrack = tracksData.tracks?.[index];
          return {
            id: track.id,
            rank: index + 1,
            title: track.name,
            album: spotifyTrack?.album?.name || null,
            albumImage: spotifyTrack?.album?.images?.[0]?.url || null,
            releaseYear: spotifyTrack?.album?.release_date?.slice(0, 4) || null,
            releaseDate: spotifyTrack?.album?.release_date || null,
            duration: track.duration,
            durationFormatted: formatDuration(track.duration),
            previewUrl: spotifyTrack?.preview_url || null,
            spotifyUrl: spotifyTrack?.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
            youtubeUrl: spotifyTrack?.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
            popularity: Math.min(100, Math.round((track.streamCount / 10000000) * 100)),
            explicit: track.contentRating === "explicit",
            streamCount: track.streamCount,
            streamCountFormatted: formatNumber(track.streamCount),
          };
        });
      } catch (trackError) {
        console.error("[Apify] Error enriching tracks:", trackError);
        // Continue with basic track data if enrichment fails
        topTracks = topTracks.map((track: any, index: number) => ({
          id: track.id,
          rank: index + 1,
          title: track.name,
          album: null,
          albumImage: null,
          releaseYear: null,
          releaseDate: null,
          duration: track.duration,
          durationFormatted: formatDuration(track.duration),
          previewUrl: null,
          spotifyUrl: `https://open.spotify.com/track/${track.id}`,
          youtubeUrl: `https://open.spotify.com/track/${track.id}`,
          popularity: Math.min(100, Math.round((track.streamCount / 10000000) * 100)),
          explicit: track.contentRating === "explicit",
          streamCount: track.streamCount,
          streamCountFormatted: formatNumber(track.streamCount),
        }));
      }
    }

   
    // Step 5: Enrich albums with Spotify images
let albums = (artistData.albums || []);
let singles = (artistData.singles || []);
let popularReleases = (artistData.popularReleases || []);

if (albums.length > 0 || singles.length > 0 || popularReleases.length > 0) {
  try {
    // Combine all releases to fetch images in one API call
    const allReleases = [...albums, ...singles, ...popularReleases];
    const allAlbumIds = allReleases.map((a: any) => a.id).slice(0, 20).join(',');
    
    if (allAlbumIds) {
      const albumsResponse = await fetch(
        `https://api.spotify.com/v1/albums?ids=${allAlbumIds}`,
        { headers: { Authorization: `Bearer ${spotifyToken}` } }
      );
      const albumsData = await albumsResponse.json();
      
      const enrichAlbum = (album: any, index: number) => {
        const spotifyAlbum = albumsData.albums?.[index];
        return {
          id: album.id,
          name: album.name,
          image: spotifyAlbum?.images?.[0]?.url || null,
          releaseDate: album.releaseDate,
          releaseYear: album.releaseDate?.slice(0, 4) || null,
          totalTracks: spotifyAlbum?.total_tracks || 0,
          type: album.type || 'album',
          spotifyUrl: spotifyAlbum?.external_urls?.spotify || `https://open.spotify.com/album/${album.id}`,
        };
      };
      
      // Enrich each category separately
      let currentIndex = 0;
      albums = albums.map((album: any) => enrichAlbum(album, currentIndex++));
      singles = singles.map((single: any) => enrichAlbum(single, currentIndex++));
      popularReleases = popularReleases.map((release: any) => enrichAlbum(release, currentIndex++));
    }
  } catch (albumError) {
    console.error("[Apify] Error enriching albums:", albumError);
    // Continue with basic album data if enrichment fails
    const basicEnrich = (item: any, type: string) => ({
      id: item.id,
      name: item.name,
      image: null,
      releaseDate: item.releaseDate,
      releaseYear: item.releaseDate?.slice(0, 4) || null,
      totalTracks: type === 'single' ? 1 : 0,
      type: item.type || type,
      spotifyUrl: `https://open.spotify.com/album/${item.id}`,
    });
    
    albums = albums.map((a: any) => basicEnrich(a, 'album'));
    singles = singles.map((s: any) => basicEnrich(s, 'single'));
    popularReleases = popularReleases.map((p: any) => basicEnrich(p, p.type || 'album'));
  }
}




//this is old one
// Step 5: Fetch albums & singles DIRECTLY from Spotify using artistId
// ✅ This always returns images — no dependency on Apify IDs
// let albums: any[] = [];
// let singles: any[] = [];
// let popularReleases = (artistData.popularReleases || []).map((p: any) => ({
//   id: p.id,
//   name: p.name,
//   image: null,
//   releaseDate: p.releaseDate || null,
//   releaseYear: p.releaseDate?.slice(0, 4) || null,
//   totalTracks: 0,
//   type: p.type || "album",
//   spotifyUrl: `https://open.spotify.com/album/${p.id}`,
// }));

// try {
//   const [albumsRes, singlesRes] = await Promise.all([
//     fetch(
//       `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album&limit=20&market=US`,
//       { headers: { Authorization: `Bearer ${spotifyToken}` } }
//     ).then(r => r.json()),

//     fetch(
//       `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=single&limit=20&market=US`,
//       { headers: { Authorization: `Bearer ${spotifyToken}` } }
//     ).then(r => r.json()),
//   ]);

//   albums = (albumsRes.items || []).map((a: any) => ({
//     id: a.id,
//     name: a.name,
//     image: a.images?.[0]?.url || null,        // ✅ Always returns image
//     releaseDate: a.release_date || null,
//     releaseYear: a.release_date?.slice(0, 4) || null,
//     totalTracks: a.total_tracks || 0,
//     type: "album",
//     spotifyUrl: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`,
//   }));

//   singles = (singlesRes.items || []).map((s: any) => ({
//     id: s.id,
//     name: s.name,
//     image: s.images?.[0]?.url || null,        // ✅ Always returns image
//     releaseDate: s.release_date || null,
//     releaseYear: s.release_date?.slice(0, 4) || null,
//     totalTracks: s.total_tracks || 0,
//     type: "single",
//     spotifyUrl: s.external_urls?.spotify || `https://open.spotify.com/album/${s.id}`,
//   }));

//   console.log(`[Spotify] Albums: ${albums.length} | Singles: ${singles.length}`);

// } catch (albumError) {
//   console.error("[Spotify] Error fetching albums:", albumError);
// }








// Step 6: Process related artists from Spotify
const relatedArtists = relatedData.artists?.slice(0, 10).map((a: any) => ({
  id: a.id,
  name: a.name,
  image: a.images?.[0]?.url || null,
  genres: a.genres || [],
  followers: a.followers?.total || 0,
  followersFormatted: formatNumber(a.followers?.total),
  popularity: a.popularity || 0,
  popularityFormatted: `${a.popularity}/100`,
  spotifyUrl: a.external_urls?.spotify,
})) || [];

// Calculate stats
const totalStreams = topTracks.reduce((sum: number, track: any) => sum + (track.streamCount || 0), 0);
const averageStreams = topTracks.length > 0 ? Math.round(totalStreams / topTracks.length) : 0;

// Build final response
const result = {
  platform: "apify",
  id: artistData.id,
  name: artistData.name,
  image: artistData.coverArt?.[0]?.url || null,
  images: artistData.coverArt || [],
  followers: formatNumber(artistData.followers),
  followersRaw: artistData.followers,
  monthlyListeners: formatNumber(artistData.monthlyListeners),
  monthlyListenersRaw: artistData.monthlyListeners,
  popularity: artistData.worldRank || 0,
  popularityFormatted: artistData.worldRank ? `#${artistData.worldRank} Worldwide` : "N/A",
  genres: fullArtist.genres || [],
  spotifyUrl: artistData._url || spotifyUrl,
  youtubeUrl: artistData._url || spotifyUrl,
  apifyUrl: artistData._url || spotifyUrl,
  verified: artistData.verified,
  
  topTracks: topTracks,
  relatedArtists: relatedArtists,
  
  // ✅ RETURN ALBUMS, SINGLES, AND POPULAR RELEASES SEPARATELY
  albums: albums,
  singles: singles,
  popularReleases: popularReleases,
  
  topCities: artistData.topCities || [],
  
  stats: {
    totalFollowers: artistData.followers,
    monthlyListeners: artistData.monthlyListeners,
    worldRank: artistData.worldRank,
    popularity: artistData.worldRank || 0,
    totalGenres: (fullArtist.genres || []).length,
    totalTopTracks: topTracks.length,
    totalRelatedArtists: relatedArtists.length,
    totalAlbums: albums.length,
    totalSingles: singles.length,
    totalPopularReleases: popularReleases.length,
    averageTrackPopularity: Math.round(averageStreams / 10000000 * 100),
    totalStreams: formatNumber(totalStreams),
    averageStreams: formatNumber(averageStreams),
  },
  
  biography: artistData.biography || null,
  externalLinks: artistData.externalLinks || [],
};

console.log(`[Apify] Success! Returning data for ${result.name}`);
console.log(`[Apify] Albums: ${albums.length}, Singles: ${singles.length}, Popular: ${popularReleases.length}`);

return new Response(
  JSON.stringify(result), 
  { 
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" } 
  }
);

  } catch (err) {
    console.error("[Apify] Error:", err);
    return new Response(
      JSON.stringify({ 
        error: err.message || "Internal server error",
        details: err.toString(),
        stack: err.stack
      }), 
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});


