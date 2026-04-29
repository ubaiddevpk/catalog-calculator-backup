




// supabase/functions/youtube/index.ts
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method === "GET") {
      return new Response(
        JSON.stringify({
          message: "YouTube Search Function",
          usage: 'Send POST request with JSON body: { "query": "Taylor Swift" }',
          status: "ready"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let query, channelId;
    try {
      const contentType = req.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const body = await req.json();
        query = body.query;
        channelId = body.channelId;
      } else {
        const text = await req.text();
        if (text) {
          const body = JSON.parse(text);
          query = body.query;
          channelId = body.channelId;
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

    const YOUTUBE_API_KEY = Deno.env.get("YOUTUBE_API_KEY");
    
    if (!YOUTUBE_API_KEY) {
      return new Response(
        JSON.stringify({ 
          error: "YouTube API key not configured in Supabase secrets",
          hint: "Add YOUTUBE_API_KEY in Edge Function settings"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[YouTube] Searching for: ${query}`);

    const formatNumber = (num) => {
      if (!num) return '0';
      if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`;
      if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
      if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
      return num.toString();
    };

    // If channelId provided, get detailed data
    if (channelId) {
      const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
      const channelResponse = await fetch(channelUrl);

      if (!channelResponse.ok) {
        return new Response(
          JSON.stringify({ error: "Failed to fetch channel details" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const channelData = await channelResponse.json();
      
      if (!channelData.items || channelData.items.length === 0) {
        return new Response(
          JSON.stringify({ error: "Channel data not available" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const channel = channelData.items[0];
      const stats = channel.statistics || {};

      // Get top videos
      const videosUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&order=viewCount&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
      const videosResponse = await fetch(videosUrl);

      let topTracks = [];
      if (videosResponse.ok) {
        const videosData = await videosResponse.json();
        
        topTracks = (videosData.items || []).map((video, idx) => ({
          id: video.id.videoId || `video-${idx}`,
          rank: idx + 1,
          title: video.snippet?.title || 'Untitled',
          album: 'YouTube Video',
          albumImage: video.snippet?.thumbnails?.high?.url || 
                     video.snippet?.thumbnails?.medium?.url || 
                     video.snippet?.thumbnails?.default?.url || null,
          releaseYear: video.snippet?.publishedAt?.split('-')[0] || 'N/A',
          releaseDate: video.snippet?.publishedAt || null,
          durationFormatted: 'N/A',
          popularity: 75,
          explicit: false,
          previewUrl: null,
          spotifyUrl: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          youtubeUrl: `https://www.youtube.com/watch?v=${video.id.videoId}`,
        }));
      }

      const subscriberCount = parseInt(stats.subscriberCount || '0');
      const viewCount = parseInt(stats.viewCount || '0');
      const videoCount = parseInt(stats.videoCount || '0');
      
      const response = {
        platform: 'youtube',
        id: channelId,
        name: channel.snippet?.title || query,
        image: channel.snippet?.thumbnails?.high?.url || 
              channel.snippet?.thumbnails?.medium?.url || 
              channel.snippet?.thumbnails?.default?.url || null,
        followers: formatNumber(subscriberCount),
        followersRaw: subscriberCount,
        totalViews: viewCount,
        totalViewsFormatted: formatNumber(viewCount),
        popularity: Math.min(100, Math.round((Math.log10(subscriberCount + 1) / 8 * 40) + (Math.log10(viewCount + 1) / 12 * 35) + (Math.min(videoCount, 1000) / 1000 * 25))),
        popularityFormatted: `${Math.min(100, Math.round((Math.log10(subscriberCount + 1) / 8 * 40) + (Math.log10(viewCount + 1) / 12 * 35) + (Math.min(videoCount, 1000) / 1000 * 25)))}/100`,
        genres: ['YouTube', 'Video Content'],
        spotifyUrl: `https://www.youtube.com/channel/${channelId}`,
        youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
        
        topTracks: topTracks,
        relatedArtists: [],
        albums: [],
        singles: [],
        popularReleases: [],
        
        stats: {
          averageTrackPopularity: 75,
          totalAlbums: 0,
          totalTopTracks: topTracks.length,
          totalRelatedArtists: 0,
          totalViews: formatNumber(viewCount),
          totalVideos: videoCount,
          totalSubscribers: formatNumber(subscriberCount),
        }
      };

      console.log(`[YouTube] Success! Returning detailed data for ${response.name}`);

      return new Response(
        JSON.stringify(response),
        { 
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    // Search for multiple channels (Base44 style)
    const searchQueries = [
      `${query} VEVO`,
      `${query} official`,
      query,
      `${query} music`,
    ];
    
    let candidateChannels = new Map();

    for (const searchQuery of searchQueries) {
      try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchQuery)}&type=channel&maxResults=10&key=${YOUTUBE_API_KEY}`;
        const searchResponse = await fetch(searchUrl);
        
        if (!searchResponse.ok) continue;
        
        const searchData = await searchResponse.json();
        
        if (!searchData.items || searchData.items.length === 0) continue;

        const channelIds = searchData.items.map(item => item.id.channelId).join(',');
        
        const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelIds}&key=${YOUTUBE_API_KEY}`;
        const channelsResponse = await fetch(channelsUrl);
        
        if (!channelsResponse.ok) continue;
        
        const channelsData = await channelsResponse.json();

        if (!channelsData.items) continue;

        for (const channel of channelsData.items) {
          if (!candidateChannels.has(channel.id)) {
            candidateChannels.set(channel.id, channel);
          }
        }
      } catch (error) {
        console.warn(`Search failed for query: ${searchQuery}`, error.message);
      }
    }
    
    const channelArray = Array.from(candidateChannels.values());
    const artistLower = query.toLowerCase();

    const rankedChannels = channelArray.map(channel => {
      let score = 0;
      const channelTitle = channel.snippet.title.toLowerCase();
      const subscriberCount = parseInt(channel.statistics.subscriberCount || 0, 10);

      if (channelTitle.includes('vevo')) score += 10;
      if (channelTitle.includes('official')) score += 8;
      if (channelTitle.endsWith(' - topic')) score += 7;
      if (channelTitle === artistLower) score += 5;
      if (channelTitle.includes(artistLower)) score += 2;
      
      score += Math.log10(subscriberCount + 1);

      return {
        ...channel,
        relevanceScore: score
      };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);

    if (rankedChannels.length === 0) {
      return new Response(
        JSON.stringify({ error: "No channels found for this artist" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const channelResults = rankedChannels.slice(0, 8).map(channel => ({
      id: channel.id,
      name: channel.snippet.title,
      description: channel.snippet.description?.substring(0, 100) + '...',
      image: channel.snippet.thumbnails?.high?.url || channel.snippet.thumbnails?.default?.url,
      subscribers: parseInt(channel.statistics.subscriberCount || 0, 10),
      subscribersFormatted: formatNumber(parseInt(channel.statistics.subscriberCount || 0, 10)),
      totalViews: parseInt(channel.statistics.viewCount || 0, 10),
      totalViewsFormatted: formatNumber(parseInt(channel.statistics.viewCount || 0, 10)),
      relevanceScore: channel.relevanceScore
    }));

    return new Response(
      JSON.stringify({ 
        type: 'channel_list',
        channels: channelResults 
      }), 
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error('[YouTube] Unexpected error:', error);
    
    return new Response(
      JSON.stringify({ 
        error: "Internal server error",
        message: error.message,
        type: error.name,
        hint: "Check function logs in Supabase Dashboard"
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  }
});
