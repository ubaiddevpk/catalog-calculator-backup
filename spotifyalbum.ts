import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const SPOTIFY_CLIENT_ID = Deno.env.get('SPOTIFY_CLIENT_ID')!
const SPOTIFY_CLIENT_SECRET = Deno.env.get('SPOTIFY_CLIENT_SECRET')!

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  try {
    const { albumId } = await req.json()

    if (!albumId) {
      return new Response(
        JSON.stringify({ error: 'Album ID is required' }),
        { 
          status: 400, 
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          } 
        }
      )
    }

    // Get Spotify access token
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`)}`,
      },
      body: 'grant_type=client_credentials',
    })

    const { access_token } = await tokenResponse.json()

    if (!access_token) {
      throw new Error('Failed to get Spotify access token')
    }

    // Fetch album details from Spotify
    const albumResponse = await fetch(
      `https://api.spotify.com/v1/albums/${albumId}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    )

    if (!albumResponse.ok) {
      const errorText = await albumResponse.text()
      console.error(`Spotify API error: ${albumResponse.status} - ${errorText}`)
      throw new Error(`Spotify API error: ${albumResponse.status}`)
    }

    const albumData = await albumResponse.json()

    return new Response(
      JSON.stringify({
        id: albumData.id,
        name: albumData.name,
        images: albumData.images,
        image: albumData.images?.[0]?.url || null,
        releaseDate: albumData.release_date,
        totalTracks: albumData.total_tracks,
        type: albumData.album_type,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    )
  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    )
  }
})
