// v2
export default {
  async fetch(request, env) {
  const url = new URL(request.url)
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  }

  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {headers: {...headers, 'Access-Control-Allow-Headers': 'Authorization, Content-Type'}})
  }


  // ── STRAVA OAUTH ─────────────────────────────────────────────────────────
  const STRAVA_CLIENT_ID = '260935';
  const STRAVA_CLIENT_SECRET = '570c52239e99be3ba40d9c47ed78d5107c5725ba';
  const STRAVA_REDIRECT_URI = 'https://mikey-food-api2.mgrobinson07.workers.dev/strava/callback';

  // Step 1: Redirect to Strava auth page
  if (url.pathname === '/strava/auth') {
    const appUrl = url.searchParams.get('app') || 'https://training-plan.mgrobinson07.workers.dev';
    const scope = 'read,activity:read_all';
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${encodeURIComponent(appUrl)}`;
    return Response.redirect(authUrl, 302);
  }

  // Step 2: OAuth callback - returns HTML page that posts token to opener
  if (url.pathname === '/strava/callback') {
    const code = url.searchParams.get('code');
    const appUrl = decodeURIComponent(url.searchParams.get('state') || 'https://training-plan.mgrobinson07.workers.dev');
    if (!code) return new Response('No code received', { status: 400 });
    try {
      const tokenRes = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: STRAVA_CLIENT_ID,
          client_secret: STRAVA_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code'
        })
      });
      const tokenData = await tokenRes.json();
      if (tokenData.errors) return new Response('Token error: ' + JSON.stringify(tokenData.errors), { status: 400 });
      const token = JSON.stringify({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: tokenData.expires_at,
        athlete_id: tokenData.athlete && tokenData.athlete.id
      });
      // Redirect back to app with token as query param
      const sep = appUrl.includes('?') ? '&' : '?';
      const redirectUrl = appUrl + sep + 'strava_token=' + encodeURIComponent(token);
      return Response.redirect(redirectUrl, 302);
    } catch(e) {
      return new Response('OAuth error: ' + e.message, { status: 500 });
    }
  }

  // Step 3: Refresh token
  if (url.pathname === '/strava/refresh') {
    const refreshToken = url.searchParams.get('refresh_token');
    if (!refreshToken) return new Response(JSON.stringify({error:'No refresh token'}), {headers});
    try {
      const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          client_id: STRAVA_CLIENT_ID,
          client_secret: STRAVA_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        })
      });
      return new Response(JSON.stringify(await res.json()), {headers});
    } catch(e) {
      return new Response(JSON.stringify({error:e.message}), {headers});
    }
  }

  // Step 4b: Debug — dump raw Strava activity fields
  if (url.pathname === '/strava/activity_debug') {
    const activityDate = url.searchParams.get('date');
    const accessToken = url.searchParams.get('token');
    const distMiles = parseFloat(url.searchParams.get('dist') || '0');
    if (!accessToken || !activityDate) return new Response(JSON.stringify({error:'Need token and date'}), {headers});
    try {
      const dateTs = Math.floor(new Date(activityDate).getTime() / 1000);
      const listRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?before=${dateTs+86400}&after=${dateTs-3600}&per_page=10`, {
        headers: {'Authorization': 'Bearer ' + accessToken}
      });
      const activities = await listRes.json();
      if (!Array.isArray(activities) || !activities.length) return new Response(JSON.stringify({error:'No activities found on '+activityDate}), {headers});
      const distMeters = distMiles * 1609.34;
      let match = activities.find(a => Math.abs((a.distance||0) - distMeters) / distMeters < 0.1) || activities[0];
      // Fetch full detail
      const detailRes = await fetch(`https://www.strava.com/api/v3/activities/${match.id}`, {
        headers: {'Authorization': 'Bearer ' + accessToken}
      });
      const detail = await detailRes.json();
      return new Response(JSON.stringify({
        id: detail.id,
        name: detail.name,
        weighted_average_watts: detail.weighted_average_watts,
        max_watts: detail.max_watts,
        average_watts: detail.average_watts,
        kilojoules: detail.kilojoules,
        device_watts: detail.device_watts,
        has_heartrate: detail.has_heartrate,
        suffer_score: detail.suffer_score,
        map_has_polyline: !!(detail.map && detail.map.polyline)
      }), {headers});
    } catch(e) {
      return new Response(JSON.stringify({error:e.message}), {headers});
    }
  }

  // Step 4: Fetch activity polyline — looks up by date if ID starts with 'i' (Intervals.icu)
  if (url.pathname === '/strava/activity') {
    const activityId = url.searchParams.get('id');
    const accessToken = url.searchParams.get('token');
    const activityDate = url.searchParams.get('date'); // YYYY-MM-DD
    const activityDist = parseFloat(url.searchParams.get('dist') || '0'); // miles
    if (!accessToken) return new Response(JSON.stringify({error:'Missing token'}), {headers});

    try {
      let stravaActivityId = activityId;

      // If ID looks like an Intervals.icu ID (starts with letter), find real Strava ID by date
      if (!activityId || isNaN(activityId) || activityId.match(/^[a-z]/i)) {
        if (!activityDate) return new Response(JSON.stringify({error:'Need date to look up Strava activity. ID: '+activityId}), {headers});
        // Search Strava activities around the given date
        const dateTs = Math.floor(new Date(activityDate).getTime() / 1000);
        const before = dateTs + 86400;
        const after = dateTs - 3600;
        const listRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?before=${before}&after=${after}&per_page=10`, {
          headers: {'Authorization': 'Bearer ' + accessToken}
        });
        if (listRes.status === 401) return new Response(JSON.stringify({error:'token_expired'}), {headers});
        const activities = await listRes.json();
        if (!Array.isArray(activities) || !activities.length) {
          return new Response(JSON.stringify({error:'No Strava activities found on '+activityDate}), {headers});
        }
        // Match by distance (within 10%) if we have it, otherwise take first ride
        let match = activities.find(a => a.type === 'Ride' || a.type === 'VirtualRide');
        if (activityDist > 0) {
          const distMeters = activityDist * 1609.34;
          match = activities.find(a => Math.abs((a.distance||0) - distMeters) / distMeters < 0.1) || match;
        }
        if (!match) return new Response(JSON.stringify({error:'No matching ride on Strava for '+activityDate}), {headers});
        stravaActivityId = match.id;
      }

      // Fetch full activity with polyline
      const res = await fetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
        headers: {'Authorization': 'Bearer ' + accessToken}
      });
      if (res.status === 401) return new Response(JSON.stringify({error:'token_expired'}), {headers});
      if (!res.ok) return new Response(JSON.stringify({error:'Strava error: '+res.status+' for ID '+stravaActivityId}), {headers});
      const data = await res.json();
      const polyline = data.map && (data.map.polyline || data.map.summary_polyline);
      // Extract power fields from Strava activity detail
      return new Response(JSON.stringify({
        polyline: polyline || null,
        strava_id: stravaActivityId,
        name: data.name,
        np: data.weighted_average_watts || null,
        avg_watts: data.average_watts || null,
        max_watts: data.max_watts || null,
        work_kj: data.kilojoules ? Math.round(data.kilojoules) : null,
        suffer_score: data.suffer_score || null,
        tss: data.suffer_score || null,
        if_pct: data.intensity_factor || null,
        device_watts: data.device_watts || false,
        elapsed_secs: data.elapsed_time || null,
        moving_secs: data.moving_time || null,
        distance_mi: data.distance ? Math.round(data.distance / 1609.34 * 10) / 10 : null,
        avg_hr: data.average_heartrate ? Math.round(data.average_heartrate) : null,
        max_hr: data.max_heartrate ? Math.round(data.max_heartrate) : null,
        calories: data.calories || null,
        avg_speed: data.average_speed ? Math.round(data.average_speed * 2.23694 * 10) / 10 : null,
        max_speed: data.max_speed ? Math.round(data.max_speed * 2.23694 * 10) / 10 : null,
        elev_ft: data.total_elevation_gain ? Math.round(data.total_elevation_gain * 3.2808) : null,
        cadence: data.average_cadence ? Math.round(data.average_cadence) : null,
        activity_type: data.type || null
      }), {headers});
    } catch(e) {
      return new Response(JSON.stringify({error:e.message}), {headers});
    }
  }

  const action = url.searchParams.get('action')

  // ── CLAUDE API PROXY ─────────────────────────────────────────────────────
  if (url.pathname.endsWith('/claude') || action === 'claude') {
    try {
      const body = await request.json()
      const apiKey = (env && env.ANTHROPIC_API_KEY) || (typeof ANTHROPIC_API_KEY !== 'undefined' ? ANTHROPIC_API_KEY : '')
      if (!apiKey) {
        return new Response(JSON.stringify({error:{message:'ANTHROPIC_API_KEY secret not set on worker'}}), {headers})
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      return new Response(JSON.stringify(data), {headers})
    } catch(e) {
      return new Response(JSON.stringify({error:{message:e.message}}), {headers})
    }
  }

  // ── INTERVALS.ICU PROXY ──────────────────────────────────────────────────

  // Fetch activity streams (power, HR, speed data)
  if (action === 'strava_streams') {
    const activityId = url.searchParams.get('id');
    const accessToken = url.searchParams.get('token');
    if (!activityId || !accessToken) return new Response(JSON.stringify({error:'Missing id or token'}), {headers});
    try {
      const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}/streams?keys=watts,heartrate,velocity_smooth&key_by_type=true&series_type=distance&resolution=low`, {
        headers: {'Authorization': 'Bearer ' + accessToken}
      });
      if (res.status === 401) return new Response(JSON.stringify({error:'token_expired'}), {headers});
      if (!res.ok) return new Response(JSON.stringify({error:'Streams error: '+res.status}), {headers});
      const data = await res.json();
      return new Response(JSON.stringify({
        watts: data.watts ? data.watts.data : null,
        heartrate: data.heartrate ? data.heartrate.data : null,
        velocity: data.velocity_smooth ? data.velocity_smooth.data.map(function(v){ return Math.round(v * 2.23694 * 10) / 10; }) : null
      }), {headers});
    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {headers});
    }
  }

  if (action === 'strava_activity') {
    const activityId = url.searchParams.get('id');
    const accessToken = url.searchParams.get('token');
    const activityDate = url.searchParams.get('date');
    const distMiles = parseFloat(url.searchParams.get('dist') || '0');
    if (!accessToken) return new Response(JSON.stringify({error:'Missing token'}), {headers});
    try {
      let stravaActivityId = activityId;
      // If ID looks like Intervals.icu ID (starts with letter or 'i'), look up by date
      if (!activityId || isNaN(activityId) || /^[a-z]/i.test(activityId)) {
        if (!activityDate) return new Response(JSON.stringify({error:'Need date to look up activity'}), {headers});
        const dateTs = Math.floor(new Date(activityDate).getTime() / 1000);
        const listRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?before=${dateTs+86400}&after=${dateTs-3600}&per_page=10`, {
          headers: {'Authorization': 'Bearer ' + accessToken}
        });
        if (listRes.status === 401) return new Response(JSON.stringify({error:'token_expired'}), {headers});
        const activities = await listRes.json();
        if (!Array.isArray(activities) || !activities.length) return new Response(JSON.stringify({error:'No Strava activities on '+activityDate}), {headers});
        const distMeters = distMiles * 1609.34;
        let match = distMiles > 0 ? activities.find(a => Math.abs((a.distance||0) - distMeters) / distMeters < 0.1) : null;
        match = match || activities.find(a => a.type === 'Ride' || a.type === 'VirtualRide') || activities[0];
        stravaActivityId = match.id;
      }
      const res = await fetch(`https://www.strava.com/api/v3/activities/${stravaActivityId}`, {
        headers: {'Authorization': 'Bearer ' + accessToken}
      });
      if (res.status === 401) return new Response(JSON.stringify({error:'token_expired'}), {headers});
      if (!res.ok) return new Response(JSON.stringify({error:'Strava error '+res.status}), {headers});
      const data = await res.json();
      const polyline = data.map && (data.map.polyline || data.map.summary_polyline);
      return new Response(JSON.stringify({
        polyline: polyline || null,
        strava_id: stravaActivityId,
        name: data.name,
        activity_type: data.type || null,
        np: data.weighted_average_watts || null,
        avg_watts: data.average_watts || null,
        max_watts: data.max_watts || null,
        work_kj: data.kilojoules ? Math.round(data.kilojoules) : null,
        suffer_score: data.suffer_score || null,
        elapsed_secs: data.elapsed_time || null,
        moving_secs: data.moving_time || null,
        distance_mi: data.distance ? Math.round(data.distance / 1609.34 * 10) / 10 : null,
        avg_hr: data.average_heartrate ? Math.round(data.average_heartrate) : null,
        max_hr: data.max_heartrate ? Math.round(data.max_heartrate) : null,
        calories: data.calories || null,
        avg_speed: data.average_speed ? Math.round(data.average_speed * 2.23694 * 10) / 10 : null,
        elev_ft: data.total_elevation_gain ? Math.round(data.total_elevation_gain * 3.2808) : null,
        cadence: data.average_cadence ? Math.round(data.average_cadence) : null
      }), {headers});
    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {headers});
    }
  }

  if (action === 'strava_auth') {
    const appUrl = url.searchParams.get('app') || 'https://training-plan.mgrobinson07.workers.dev';
    const scope = 'read,activity:read_all';
    const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${encodeURIComponent(appUrl)}`;
    return Response.redirect(authUrl, 302);
  }

  // Fetch single activity detail (more fields than list endpoint)
  if (action === 'intervals_activity') {
    const athleteId = url.searchParams.get('athlete') || 'i544205'
    const apiKey = url.searchParams.get('key')
    const actId = url.searchParams.get('id')
    if (!apiKey || !actId) return new Response(JSON.stringify({error:'Missing key or id'}), {headers})
    try {
      const auth = btoa(unescape(encodeURIComponent('API_KEY:' + apiKey)))
      const res = await fetch(`https://intervals.icu/api/v1/activity/${actId}`, {
        headers: {'Authorization': 'Basic ' + auth}
      })
      if (!res.ok) return new Response(JSON.stringify({error:'ICU error: '+res.status}), {headers})
      const data = await res.json()
      return new Response(JSON.stringify({
        np: data.weighted_average_watts || data.icu_normalized_watts || null,
        maxPwr: data.max_watts || data.icu_max_watts || null,
        max20: data.icu_20min_watts || data.p1200 || null,
        workKj: data.kilojoules || (data.icu_joules ? Math.round(data.icu_joules/1000) : null),
        ifPct: data.icu_intensity || null,
        tss: data.icu_training_load || null,
        // debug
        all_keys: Object.keys(data).filter(k => k.includes('watt') || k.includes('power') || k.includes('kj') || k.includes('joule') || k.includes('intensity') || k.includes('p1') || k.includes('p3') || k.includes('p12'))
      }), {headers})
    } catch(e) {
      return new Response(JSON.stringify({error:e.message}), {headers})
    }
  }



  // Wellness/PMC endpoint — returns CTL, ATL, TSB for last N days
  if (action === 'intervals_wellness') {
    const athleteId = url.searchParams.get('athlete') || 'i544205'
    const apiKey = url.searchParams.get('key')
    const days = parseInt(url.searchParams.get('days') || '90')
    if (!apiKey) return new Response(JSON.stringify({error:'No API key'}), {headers})
    try {
      const auth = btoa(unescape(encodeURIComponent('API_KEY:' + apiKey)))
      const oldest = new Date(Date.now() - days*24*60*60*1000).toISOString().slice(0,10)
      const wUrl = `https://intervals.icu/api/v1/athlete/${athleteId}/wellness?oldest=${oldest}`
      const res = await fetch(wUrl, {headers: {'Authorization': 'Basic ' + auth}})
      if (!res.ok) return new Response(JSON.stringify({error:'Intervals.icu wellness error: '+res.status}), {headers})
      const data = await res.json()
      return new Response(JSON.stringify({wellness: data}), {headers})
    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {headers})
    }
  }

  if (action === 'intervals_sync') {
    const athleteId = url.searchParams.get('athlete') || 'i544205'
    const apiKey = url.searchParams.get('key')
    const oldest = url.searchParams.get('oldest') || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10)
    if (!apiKey) return new Response(JSON.stringify({error:'No API key'}), {headers})
    try {
      const auth = btoa(unescape(encodeURIComponent('API_KEY:' + apiKey)))
      const iUrl = `https://intervals.icu/api/v1/athlete/${athleteId}/activities?oldest=${oldest}&limit=200`
      const res = await fetch(iUrl, {headers: {'Authorization': 'Basic ' + auth}})
      if (!res.ok) return new Response(JSON.stringify({error:'Intervals.icu error: '+res.status}), {headers})
      const data = await res.json()
      return new Response(JSON.stringify({activities: data}), {headers})
    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {headers})
    }
  }

  // ── INTERVALS.ICU ACTIVITY DEBUG ─────────────────────────────────────────
  if (action === 'intervals_activity_debug') {
    const athleteId = url.searchParams.get('athlete') || 'i544205'
    const apiKey = url.searchParams.get('key')
    if (!apiKey) return new Response(JSON.stringify({error:'No API key'}), {headers})
    try {
      const auth = btoa(unescape(encodeURIComponent('API_KEY:' + apiKey)))
      const oldest = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10)
      const iUrl = `https://intervals.icu/api/v1/athlete/${athleteId}/activities?oldest=${oldest}&limit=1`
      const res = await fetch(iUrl, {headers: {'Authorization': 'Basic ' + auth}})
      const data = await res.json()
      const first = Array.isArray(data) ? data[0] : data
      // Return the FULL raw activity so we can see every field
      return new Response(JSON.stringify(first), {headers})
    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {headers})
    }
  }

  // ── FOOD SEARCH ──────────────────────────────────────────────────────────
  const q = url.searchParams.get('q')
  if (!q) return new Response(JSON.stringify({foods:[]}), {headers})

  try {
    // Run USDA branded + foundation searches in parallel for better coverage
    const usdaBase = 'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=bC38HIShNhDzbFJH9jQUa6HgGFLKzMeeHNrhEeUB'
    const usdaBrandedUrl = usdaBase + '&query=' + encodeURIComponent(q) + '&pageSize=25&dataType=Branded&sortBy=score&sortOrder=desc'
    const usdaFoundationUrl = usdaBase + '&query=' + encodeURIComponent(q) + '&pageSize=10&dataType=Foundation,SR%20Legacy,Survey%20(FNDDS)&sortBy=score&sortOrder=desc'

    const [brandedRes, foundationRes] = await Promise.allSettled([
      fetch(usdaBrandedUrl),
      fetch(usdaFoundationUrl)
    ])

    function parseUSDA(data) {
      return (data.foods||[]).map(p => {
        let cal=0,pro=0,carb=0,fat=0,fiber=0,satFat=0,sodium=0,sugar=0,cholesterol=0
        ;(p.foodNutrients||[]).forEach(n => {
          const id = n.nutrientId || n.nutrientNumber
          if(id==1008||id=='208') cal=Math.round(n.value||0)
          else if(id==1003||id=='203') pro=Math.round((n.value||0)*10)/10
          else if(id==1005||id=='205') carb=Math.round((n.value||0)*10)/10
          else if(id==1004||id=='204') fat=Math.round((n.value||0)*10)/10
          else if(id==1079||id=='291') fiber=Math.round((n.value||0)*10)/10
          else if(id==1258||id=='606') satFat=Math.round((n.value||0)*10)/10
          else if(id==1093||id=='307') sodium=Math.round(n.value||0)
          else if(id==2000||id=='269') sugar=Math.round((n.value||0)*10)/10
          else if(id==1253||id=='601') cholesterol=Math.round(n.value||0)
        })
        if(!cal && !pro && !carb) return null
        // Build clean name: Description - Brand
        const brand = (p.brandOwner||p.brandName||'').split(',')[0].trim()
        const desc = (p.description||'').trim()
        // Avoid duplicate brand in name
        const name = brand && !desc.toLowerCase().includes(brand.toLowerCase().substring(0,6))
          ? desc + ' — ' + brand
          : desc
        return {
          n: name,
          cal, p:pro, c:carb, f:fat, fiber, satFat, sodium, sugar, cholesterol,
          srv: p.servingSize ? Math.round(p.servingSize)+(p.servingSizeUnit||'g') : '1 serving',
          fdcId: p.fdcId
        }
      }).filter(Boolean)
    }

    let foods = []

    if (brandedRes.status === 'fulfilled' && brandedRes.value.ok) {
      const data = await brandedRes.value.json()
      foods = foods.concat(parseUSDA(data))
    }

    if (foundationRes.status === 'fulfilled' && foundationRes.value.ok) {
      const data = await foundationRes.value.json()
      foods = foods.concat(parseUSDA(data))
    }

    // Sort by relevance: exact brand/name match first
    const qLower = q.toLowerCase()
    foods.sort((a, b) => {
      const aName = a.n.toLowerCase()
      const bName = b.n.toLowerCase()
      const aExact = aName.startsWith(qLower) ? 2 : aName.includes(qLower) ? 1 : 0
      const bExact = bName.startsWith(qLower) ? 2 : bName.includes(qLower) ? 1 : 0
      return bExact - aExact
    })

    // Deduplicate by name similarity (allow different serving sizes through)
    const seen = new Set()
    foods = foods.filter(f => {
      // Key on first 30 chars of normalized name to allow variants
      const key = f.n.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,30)
      if(seen.has(key)) return false
      seen.add(key)
      return true
    })

    return new Response(JSON.stringify({foods: foods.slice(0,40)}), {headers})
  } catch(e) {
    return new Response(JSON.stringify({foods:[], error:e.message}), {headers})
  }
  }
}