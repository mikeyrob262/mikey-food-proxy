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
  const LOCAL_FOODS = [{"name":"Chicken Sandwich","brand":"Chick-fil-A","calories":440,"protein":28,"carbs":41,"fat":19,"serving":"1 sandwich"},{"name":"Spicy Chicken Sandwich","brand":"Chick-fil-A","calories":450,"protein":28,"carbs":42,"fat":19,"serving":"1 sandwich"},{"name":"Grilled Chicken Sandwich","brand":"Chick-fil-A","calories":320,"protein":28,"carbs":41,"fat":6,"serving":"1 sandwich"},{"name":"Chicken Nuggets (8ct)","brand":"Chick-fil-A","calories":250,"protein":27,"carbs":11,"fat":11,"serving":"8 pieces"},{"name":"Chicken Nuggets (12ct)","brand":"Chick-fil-A","calories":380,"protein":41,"carbs":16,"fat":17,"serving":"12 pieces"},{"name":"Grilled Nuggets (8ct)","brand":"Chick-fil-A","calories":130,"protein":25,"carbs":1,"fat":2,"serving":"8 pieces"},{"name":"Waffle Fries (Medium)","brand":"Chick-fil-A","calories":420,"protein":5,"carbs":45,"fat":24,"serving":"medium"},{"name":"Waffle Fries (Small)","brand":"Chick-fil-A","calories":320,"protein":4,"carbs":35,"fat":18,"serving":"small"},{"name":"Chicken Biscuit","brand":"Chick-fil-A","calories":460,"protein":18,"carbs":43,"fat":25,"serving":"1 biscuit"},{"name":"Mac & Cheese","brand":"Chick-fil-A","calories":450,"protein":19,"carbs":32,"fat":28,"serving":"1 serving"},{"name":"Cobb Salad with Chicken","brand":"Chick-fil-A","calories":510,"protein":40,"carbs":21,"fat":30,"serving":"1 salad"},{"name":"Market Salad","brand":"Chick-fil-A","calories":450,"protein":24,"carbs":40,"fat":23,"serving":"1 salad"},{"name":"Chick-fil-A Sauce","brand":"Chick-fil-A","calories":140,"protein":0,"carbs":5,"fat":13,"serving":"1 packet"},{"name":"Big Mac","brand":"McDonald's","calories":550,"protein":25,"carbs":45,"fat":30,"serving":"1 sandwich"},{"name":"Quarter Pounder with Cheese","brand":"McDonald's","calories":520,"protein":30,"carbs":41,"fat":26,"serving":"1 sandwich"},{"name":"Double Quarter Pounder","brand":"McDonald's","calories":740,"protein":47,"carbs":42,"fat":42,"serving":"1 sandwich"},{"name":"McChicken","brand":"McDonald's","calories":400,"protein":14,"carbs":39,"fat":21,"serving":"1 sandwich"},{"name":"10 Piece Chicken McNuggets","brand":"McDonald's","calories":410,"protein":23,"carbs":26,"fat":24,"serving":"10 pieces"},{"name":"4 Piece Chicken McNuggets","brand":"McDonald's","calories":170,"protein":9,"carbs":11,"fat":10,"serving":"4 pieces"},{"name":"Medium Fries","brand":"McDonald's","calories":320,"protein":4,"carbs":43,"fat":15,"serving":"medium"},{"name":"Large Fries","brand":"McDonald's","calories":480,"protein":6,"carbs":64,"fat":23,"serving":"large"},{"name":"Small Fries","brand":"McDonald's","calories":230,"protein":3,"carbs":30,"fat":11,"serving":"small"},{"name":"Egg McMuffin","brand":"McDonald's","calories":310,"protein":17,"carbs":30,"fat":13,"serving":"1 sandwich"},{"name":"Sausage McMuffin with Egg","brand":"McDonald's","calories":480,"protein":21,"carbs":30,"fat":31,"serving":"1 sandwich"},{"name":"Hash Brown","brand":"McDonald's","calories":150,"protein":1,"carbs":15,"fat":9,"serving":"1 piece"},{"name":"Filet-O-Fish","brand":"McDonald's","calories":380,"protein":16,"carbs":39,"fat":18,"serving":"1 sandwich"},{"name":"McDouble","brand":"McDonald's","calories":400,"protein":22,"carbs":33,"fat":20,"serving":"1 sandwich"},{"name":"Hamburger","brand":"Five Guys","calories":700,"protein":39,"carbs":39,"fat":43,"serving":"1 burger"},{"name":"Cheeseburger","brand":"Five Guys","calories":840,"protein":47,"carbs":40,"fat":56,"serving":"1 burger"},{"name":"Little Hamburger","brand":"Five Guys","calories":480,"protein":25,"carbs":39,"fat":26,"serving":"1 burger"},{"name":"Little Cheeseburger","brand":"Five Guys","calories":560,"protein":29,"carbs":39,"fat":33,"serving":"1 burger"},{"name":"Bacon Cheeseburger","brand":"Five Guys","calories":920,"protein":53,"carbs":40,"fat":60,"serving":"1 burger"},{"name":"Regular Fries","brand":"Five Guys","calories":953,"protein":14,"carbs":131,"fat":43,"serving":"regular"},{"name":"Little Fries","brand":"Five Guys","calories":480,"protein":7,"carbs":66,"fat":22,"serving":"little"},{"name":"Cajun Fries (Regular)","brand":"Five Guys","calories":953,"protein":14,"carbs":131,"fat":43,"serving":"regular"},{"name":"Bacon Dog","brand":"Five Guys","calories":660,"protein":24,"carbs":42,"fat":45,"serving":"1 hot dog"},{"name":"Grilled Cheese","brand":"Five Guys","calories":440,"protein":18,"carbs":38,"fat":26,"serving":"1 sandwich"},{"name":"ButterBurger Single","brand":"Culver's","calories":460,"protein":23,"carbs":39,"fat":24,"serving":"1 burger"},{"name":"ButterBurger Cheese Single","brand":"Culver's","calories":520,"protein":26,"carbs":40,"fat":29,"serving":"1 burger"},{"name":"ButterBurger Double","brand":"Culver's","calories":700,"protein":40,"carbs":39,"fat":41,"serving":"1 burger"},{"name":"Crinkle Cut Fries (Regular)","brand":"Culver's","calories":460,"protein":6,"carbs":56,"fat":24,"serving":"regular"},{"name":"Crinkle Cut Fries (Value)","brand":"Culver's","calories":340,"protein":4,"carbs":41,"fat":18,"serving":"value"},{"name":"Wisconsin Cheese Curds (Regular)","brand":"Culver's","calories":540,"protein":22,"carbs":38,"fat":33,"serving":"regular"},{"name":"Chicken Tenders (3pc)","brand":"Culver's","calories":330,"protein":30,"carbs":18,"fat":16,"serving":"3 pieces"},{"name":"Original ButterBurger Snack","brand":"Culver's","calories":330,"protein":14,"carbs":28,"fat":18,"serving":"snack size"},{"name":"Vanilla Fresh Frozen Custard","brand":"Culver's","calories":290,"protein":5,"carbs":30,"fat":16,"serving":"1 dish"},{"name":"Concrete Mixer (Mini)","brand":"Culver's","calories":410,"protein":7,"carbs":51,"fat":19,"serving":"mini"},{"name":"Caffe Latte (Grande, 2%)","brand":"Starbucks","calories":190,"protein":13,"carbs":19,"fat":7,"serving":"16 fl oz"},{"name":"Caffe Latte (Tall, 2%)","brand":"Starbucks","calories":150,"protein":10,"carbs":14,"fat":6,"serving":"12 fl oz"},{"name":"Cappuccino (Grande, 2%)","brand":"Starbucks","calories":140,"protein":9,"carbs":14,"fat":5,"serving":"16 fl oz"},{"name":"Caramel Macchiato (Grande)","brand":"Starbucks","calories":250,"protein":10,"carbs":35,"fat":7,"serving":"16 fl oz"},{"name":"Caramel Frappuccino (Grande)","brand":"Starbucks","calories":380,"protein":5,"carbs":67,"fat":11,"serving":"16 fl oz"},{"name":"Pumpkin Spice Latte (Grande)","brand":"Starbucks","calories":380,"protein":14,"carbs":52,"fat":14,"serving":"16 fl oz"},{"name":"Iced Coffee (Grande, Black)","brand":"Starbucks","calories":5,"protein":0,"carbs":0,"fat":0,"serving":"16 fl oz"},{"name":"Cold Brew (Grande, Black)","brand":"Starbucks","calories":5,"protein":0,"carbs":0,"fat":0,"serving":"16 fl oz"},{"name":"Vanilla Sweet Cream Cold Brew (Grande)","brand":"Starbucks","calories":220,"protein":1,"carbs":25,"fat":13,"serving":"16 fl oz"},{"name":"Pink Drink (Grande)","brand":"Starbucks","calories":140,"protein":0,"carbs":25,"fat":2,"serving":"16 fl oz"},{"name":"Egg White & Roasted Red Pepper Egg Bites","brand":"Starbucks","calories":170,"protein":13,"carbs":13,"fat":8,"serving":"2 pieces"},{"name":"Bacon & Gruyere Egg Bites","brand":"Starbucks","calories":300,"protein":19,"carbs":9,"fat":21,"serving":"2 pieces"},{"name":"Butter Croissant","brand":"Starbucks","calories":310,"protein":6,"carbs":33,"fat":16,"serving":"1 croissant"},{"name":"Spinach Feta Wrap","brand":"Starbucks","calories":290,"protein":14,"carbs":33,"fat":12,"serving":"1 wrap"},{"name":"Protein Box (Eggs & Cheese)","brand":"Starbucks","calories":470,"protein":23,"carbs":32,"fat":27,"serving":"1 box"},{"name":"Chocolate Croissant","brand":"Starbucks","calories":340,"protein":6,"carbs":37,"fat":19,"serving":"1 croissant"},{"name":"Banana Nut Bread","brand":"Starbucks","calories":420,"protein":6,"carbs":56,"fat":20,"serving":"1 slice"},{"name":"Americano (Grande)","brand":"Starbucks","calories":15,"protein":1,"carbs":3,"fat":0,"serving":"16 fl oz"},{"name":"Chicken Burrito Bowl (standard)","brand":"Chipotle","calories":625,"protein":47,"carbs":60,"fat":21,"serving":"1 bowl"},{"name":"Steak Burrito Bowl (standard)","brand":"Chipotle","calories":645,"protein":38,"carbs":58,"fat":28,"serving":"1 bowl"},{"name":"Carnitas Burrito Bowl (standard)","brand":"Chipotle","calories":640,"protein":35,"carbs":58,"fat":30,"serving":"1 bowl"},{"name":"Sofritas Burrito Bowl (standard)","brand":"Chipotle","calories":575,"protein":19,"carbs":67,"fat":24,"serving":"1 bowl"},{"name":"Chicken Burrito","brand":"Chipotle","calories":1050,"protein":50,"carbs":113,"fat":39,"serving":"1 burrito"},{"name":"Chicken Salad Bowl","brand":"Chipotle","calories":350,"protein":35,"carbs":19,"fat":14,"serving":"1 bowl"},{"name":"Chips","brand":"Chipotle","calories":540,"protein":7,"carbs":65,"fat":27,"serving":"4 oz"},{"name":"Guacamole","brand":"Chipotle","calories":230,"protein":2,"carbs":8,"fat":22,"serving":"4 oz"},{"name":"White Rice","brand":"Chipotle","calories":210,"protein":4,"carbs":40,"fat":4,"serving":"4 oz"},{"name":"Brown Rice","brand":"Chipotle","calories":210,"protein":4,"carbs":36,"fat":6,"serving":"4 oz"},{"name":"Black Beans","brand":"Chipotle","calories":130,"protein":8,"carbs":22,"fat":1,"serving":"4 oz"},{"name":"Pinto Beans","brand":"Chipotle","calories":130,"protein":8,"carbs":19,"fat":2,"serving":"4 oz"},{"name":"Fajita Veggies","brand":"Chipotle","calories":20,"protein":1,"carbs":4,"fat":0,"serving":"2.5 oz"},{"name":"Chicken (4oz)","brand":"Chipotle","calories":180,"protein":32,"carbs":0,"fat":7,"serving":"4 oz"},{"name":"Steak (4oz)","brand":"Chipotle","calories":150,"protein":21,"carbs":2,"fat":6,"serving":"4 oz"},{"name":"Queso Blanco","brand":"Chipotle","calories":120,"protein":6,"carbs":4,"fat":9,"serving":"2 oz"},{"name":"Sour Cream","brand":"Chipotle","calories":110,"protein":2,"carbs":2,"fat":9,"serving":"2 oz"},{"name":"Tortilla (Flour, Burrito)","brand":"Chipotle","calories":300,"protein":8,"carbs":50,"fat":9,"serving":"1 tortilla"},{"name":"Broccoli Cheddar Soup (Bowl)","brand":"Panera","calories":360,"protein":13,"carbs":25,"fat":24,"serving":"1 bowl"},{"name":"Chicken Noodle Soup (Bowl)","brand":"Panera","calories":140,"protein":9,"carbs":16,"fat":3,"serving":"1 bowl"},{"name":"Turkey Chili (Bowl)","brand":"Panera","calories":240,"protein":24,"carbs":27,"fat":4,"serving":"1 bowl"},{"name":"Fuji Apple Chicken Salad (Full)","brand":"Panera","calories":590,"protein":32,"carbs":48,"fat":32,"serving":"full"},{"name":"Caesar Salad with Chicken (Full)","brand":"Panera","calories":470,"protein":36,"carbs":22,"fat":27,"serving":"full"},{"name":"Bacon Turkey Bravo Sandwich (Whole)","brand":"Panera","calories":800,"protein":45,"carbs":64,"fat":39,"serving":"whole"},{"name":"You Pick Two (Half Sandwich & Cup Soup)","brand":"Panera","calories":470,"protein":19,"carbs":49,"fat":22,"serving":"combo"},{"name":"Bagel, Plain","brand":"Panera","calories":290,"protein":11,"carbs":59,"fat":1,"serving":"1 bagel"},{"name":"Bagel, Asiago Cheese","brand":"Panera","calories":330,"protein":14,"carbs":56,"fat":5,"serving":"1 bagel"},{"name":"Cinnamon Crunch Bagel","brand":"Panera","calories":430,"protein":9,"carbs":78,"fat":9,"serving":"1 bagel"},{"name":"Turkey Breast Sub (6in)","brand":"Subway","calories":280,"protein":18,"carbs":46,"fat":3.5,"serving":"6 inch"},{"name":"Italian BMT (6in)","brand":"Subway","calories":410,"protein":19,"carbs":44,"fat":18,"serving":"6 inch"},{"name":"Tuna Sub (6in)","brand":"Subway","calories":480,"protein":19,"carbs":41,"fat":27,"serving":"6 inch"},{"name":"Chicken Teriyaki Sub (6in)","brand":"Subway","calories":370,"protein":26,"carbs":51,"fat":5,"serving":"6 inch"},{"name":"Meatball Marinara Sub (6in)","brand":"Subway","calories":480,"protein":21,"carbs":53,"fat":19,"serving":"6 inch"},{"name":"Veggie Delite Sub (6in)","brand":"Subway","calories":200,"protein":8,"carbs":38,"fat":2.5,"serving":"6 inch"},{"name":"Steak & Cheese Sub (6in)","brand":"Subway","calories":380,"protein":24,"carbs":45,"fat":11,"serving":"6 inch"},{"name":"Dave's Single","brand":"Wendy's","calories":590,"protein":29,"carbs":39,"fat":34,"serving":"1 burger"},{"name":"Baconator","brand":"Wendy's","calories":950,"protein":58,"carbs":39,"fat":63,"serving":"1 burger"},{"name":"Spicy Chicken Sandwich","brand":"Wendy's","calories":510,"protein":28,"carbs":51,"fat":21,"serving":"1 sandwich"},{"name":"4 Piece Chicken Nuggets","brand":"Wendy's","calories":170,"protein":9,"carbs":11,"fat":11,"serving":"4 pieces"},{"name":"10 Piece Chicken Nuggets","brand":"Wendy's","calories":420,"protein":21,"carbs":26,"fat":27,"serving":"10 pieces"},{"name":"Medium Natural Cut Fries","brand":"Wendy's","calories":420,"protein":6,"carbs":56,"fat":19,"serving":"medium"},{"name":"Chili (Small)","brand":"Wendy's","calories":220,"protein":18,"carbs":23,"fat":6,"serving":"small"},{"name":"Frosty (Small)","brand":"Wendy's","calories":340,"protein":8,"carbs":56,"fat":9,"serving":"small"},{"name":"Crunchy Taco","brand":"Taco Bell","calories":170,"protein":8,"carbs":13,"fat":10,"serving":"1 taco"},{"name":"Soft Taco","brand":"Taco Bell","calories":180,"protein":9,"carbs":17,"fat":9,"serving":"1 taco"},{"name":"Chicken Burrito Supreme","brand":"Taco Bell","calories":410,"protein":17,"carbs":51,"fat":14,"serving":"1 burrito"},{"name":"Beef Burrito Supreme","brand":"Taco Bell","calories":430,"protein":18,"carbs":50,"fat":18,"serving":"1 burrito"},{"name":"Crunchwrap Supreme","brand":"Taco Bell","calories":530,"protein":16,"carbs":71,"fat":21,"serving":"1 wrap"},{"name":"Cheesy Gordita Crunch","brand":"Taco Bell","calories":500,"protein":21,"carbs":41,"fat":28,"serving":"1 item"},{"name":"Chalupa Supreme, Beef","brand":"Taco Bell","calories":350,"protein":13,"carbs":30,"fat":20,"serving":"1 chalupa"},{"name":"Mexican Pizza","brand":"Taco Bell","calories":540,"protein":21,"carbs":46,"fat":30,"serving":"1 pizza"},{"name":"Cheese Pizza Slice","brand":"Generic","calories":285,"protein":12,"carbs":36,"fat":10,"serving":"1 slice"},{"name":"Pepperoni Pizza Slice","brand":"Generic","calories":313,"protein":13,"carbs":35,"fat":14,"serving":"1 slice"},{"name":"Domino's Hand Tossed Cheese Slice","brand":"Domino's","calories":230,"protein":9,"carbs":28,"fat":8,"serving":"1 slice"},{"name":"Pizza Hut Pan Pizza Slice (Cheese)","brand":"Pizza Hut","calories":280,"protein":11,"carbs":29,"fat":14,"serving":"1 slice"},{"name":"Papa John's Original Crust Cheese Slice","brand":"Papa John's","calories":210,"protein":9,"carbs":26,"fat":8,"serving":"1 slice"},{"name":"Original Blend Coffee (Medium, Black)","brand":"Dunkin'","calories":5,"protein":0,"carbs":1,"fat":0,"serving":"medium"},{"name":"Iced Coffee with Cream (Medium)","brand":"Dunkin'","calories":120,"protein":1,"carbs":12,"fat":9,"serving":"medium"},{"name":"Bacon Egg & Cheese on English Muffin","brand":"Dunkin'","calories":360,"protein":19,"carbs":26,"fat":20,"serving":"1 sandwich"},{"name":"Glazed Donut","brand":"Dunkin'","calories":240,"protein":3,"carbs":31,"fat":11,"serving":"1 donut"},{"name":"Boston Kreme Donut","brand":"Dunkin'","calories":270,"protein":3,"carbs":35,"fat":13,"serving":"1 donut"},{"name":"Munchkins, Glazed (5pc)","brand":"Dunkin'","calories":200,"protein":2,"carbs":26,"fat":9,"serving":"5 pieces"},{"name":"Hash Browns","brand":"Dunkin'","calories":220,"protein":2,"carbs":20,"fat":15,"serving":"1 serving"},{"name":"Hamburger","brand":"In-N-Out","calories":390,"protein":16,"carbs":39,"fat":19,"serving":"1 burger"},{"name":"Cheeseburger","brand":"In-N-Out","calories":480,"protein":22,"carbs":39,"fat":27,"serving":"1 burger"},{"name":"Double-Double","brand":"In-N-Out","calories":670,"protein":37,"carbs":39,"fat":41,"serving":"1 burger"},{"name":"Animal Style Fries","brand":"In-N-Out","calories":750,"protein":16,"carbs":76,"fat":41,"serving":"1 order"},{"name":"Fries","brand":"In-N-Out","calories":395,"protein":7,"carbs":54,"fat":18,"serving":"1 order"},{"name":"Spicy Chicken Sandwich","brand":"Popeyes","calories":700,"protein":28,"carbs":55,"fat":42,"serving":"1 sandwich"},{"name":"Classic Chicken Sandwich","brand":"Popeyes","calories":690,"protein":27,"carbs":56,"fat":40,"serving":"1 sandwich"},{"name":"2 Piece Chicken (Spicy)","brand":"Popeyes","calories":660,"protein":36,"carbs":26,"fat":46,"serving":"2 pieces"},{"name":"Red Beans and Rice","brand":"Popeyes","calories":230,"protein":7,"carbs":32,"fat":8,"serving":"1 side"},{"name":"Cajun Fries (Regular)","brand":"Popeyes","calories":260,"protein":3,"carbs":33,"fat":13,"serving":"regular"},{"name":"3 Finger Combo","brand":"Raising Cane's","calories":720,"protein":28,"carbs":67,"fat":38,"serving":"1 combo"},{"name":"Chicken Fingers (3pc)","brand":"Raising Cane's","calories":290,"protein":28,"carbs":12,"fat":14,"serving":"3 pieces"},{"name":"Crinkle Cut Fries (Regular)","brand":"Raising Cane's","calories":360,"protein":4,"carbs":47,"fat":17,"serving":"regular"},{"name":"Cane's Sauce","brand":"Raising Cane's","calories":140,"protein":0,"carbs":2,"fat":15,"serving":"2 oz"},{"name":"Texas Toast","brand":"Raising Cane's","calories":170,"protein":4,"carbs":21,"fat":8,"serving":"1 slice"},{"name":"Whataburger","brand":"Whataburger","calories":600,"protein":28,"carbs":60,"fat":27,"serving":"1 burger"},{"name":"Whataburger Jr.","brand":"Whataburger","calories":300,"protein":14,"carbs":31,"fat":13,"serving":"1 burger"},{"name":"Double Meat Whataburger","brand":"Whataburger","calories":830,"protein":47,"carbs":60,"fat":44,"serving":"1 burger"},{"name":"Honey BBQ Chicken Strip Sandwich","brand":"Whataburger","calories":600,"protein":25,"carbs":78,"fat":19,"serving":"1 sandwich"},{"name":"Taquito with Bacon","brand":"Whataburger","calories":320,"protein":13,"carbs":24,"fat":19,"serving":"1 taquito"},{"name":"Classic Sirloin (6oz)","brand":"Chili's","calories":330,"protein":36,"carbs":2,"fat":19,"serving":"6 oz"},{"name":"Bottomless Chips and Salsa","brand":"Chili's","calories":600,"protein":9,"carbs":80,"fat":28,"serving":"1 serving"},{"name":"Honey Chipotle Crispers","brand":"Chili's","calories":1830,"protein":60,"carbs":160,"fat":100,"serving":"1 serving"},{"name":"Chicken Alfredo","brand":"Olive Garden","calories":1280,"protein":56,"carbs":75,"fat":80,"serving":"1 entree"},{"name":"Breadstick","brand":"Olive Garden","calories":150,"protein":5,"carbs":27,"fat":2.5,"serving":"1 breadstick"},{"name":"Chicken Parmigiana","brand":"Olive Garden","calories":1090,"protein":56,"carbs":80,"fat":56,"serving":"1 entree"},{"name":"Minestrone Soup (Bowl)","brand":"Olive Garden","calories":120,"protein":4,"carbs":23,"fat":1.5,"serving":"1 bowl"},{"name":"Chicken Breast, Grilled (Skinless)","brand":"Generic","calories":165,"protein":31,"carbs":0,"fat":3.6,"serving":"100g"},{"name":"Chicken Thigh, Grilled (Skinless)","brand":"Generic","calories":209,"protein":26,"carbs":0,"fat":10.9,"serving":"100g"},{"name":"Ground Beef 93/7, Cooked","brand":"Generic","calories":182,"protein":25,"carbs":0,"fat":8,"serving":"100g"},{"name":"Ground Beef 80/20, Cooked","brand":"Generic","calories":254,"protein":22,"carbs":0,"fat":18,"serving":"100g"},{"name":"Salmon, Cooked","brand":"Generic","calories":206,"protein":22,"carbs":0,"fat":13,"serving":"100g"},{"name":"Tilapia, Cooked","brand":"Generic","calories":128,"protein":26,"carbs":0,"fat":2.7,"serving":"100g"},{"name":"Egg, Whole, Large","brand":"Generic","calories":72,"protein":6.3,"carbs":0.4,"fat":4.8,"serving":"1 egg"},{"name":"Egg White, Large","brand":"Generic","calories":17,"protein":3.6,"carbs":0.2,"fat":0.1,"serving":"1 white"},{"name":"Greek Yogurt, Plain Nonfat","brand":"Generic","calories":100,"protein":17,"carbs":6,"fat":0.7,"serving":"170g (6oz)"},{"name":"Greek Yogurt, Plain Whole Milk","brand":"Generic","calories":220,"protein":12,"carbs":9,"fat":16,"serving":"227g (8oz)"},{"name":"Cottage Cheese, Low Fat 2%","brand":"Generic","calories":90,"protein":12,"carbs":5,"fat":2.5,"serving":"100g"},{"name":"Oats, Rolled, Dry","brand":"Generic","calories":379,"protein":13,"carbs":67,"fat":6.5,"serving":"100g"},{"name":"White Rice, Cooked","brand":"Generic","calories":130,"protein":2.7,"carbs":28,"fat":0.3,"serving":"100g"},{"name":"Brown Rice, Cooked","brand":"Generic","calories":123,"protein":2.6,"carbs":26,"fat":1,"serving":"100g"},{"name":"Quinoa, Cooked","brand":"Generic","calories":120,"protein":4.4,"carbs":21,"fat":1.9,"serving":"100g"},{"name":"Sweet Potato, Baked","brand":"Generic","calories":90,"protein":2,"carbs":21,"fat":0.2,"serving":"100g"},{"name":"White Potato, Baked","brand":"Generic","calories":93,"protein":2.5,"carbs":21,"fat":0.1,"serving":"100g"},{"name":"Broccoli, Steamed","brand":"Generic","calories":35,"protein":2.4,"carbs":7.2,"fat":0.4,"serving":"100g"},{"name":"Spinach, Raw","brand":"Generic","calories":23,"protein":2.9,"carbs":3.6,"fat":0.4,"serving":"100g"},{"name":"Banana, Medium","brand":"Generic","calories":105,"protein":1.3,"carbs":27,"fat":0.4,"serving":"1 medium"},{"name":"Apple, Medium","brand":"Generic","calories":95,"protein":0.5,"carbs":25,"fat":0.3,"serving":"1 medium"},{"name":"Avocado","brand":"Generic","calories":240,"protein":3,"carbs":13,"fat":22,"serving":"1 whole"},{"name":"Almonds","brand":"Generic","calories":164,"protein":6,"carbs":6,"fat":14,"serving":"28g (1oz)"},{"name":"Peanut Butter","brand":"Generic","calories":188,"protein":8,"carbs":6,"fat":16,"serving":"2 tbsp"},{"name":"Olive Oil","brand":"Generic","calories":119,"protein":0,"carbs":0,"fat":14,"serving":"1 tbsp"},{"name":"Whole Milk","brand":"Generic","calories":149,"protein":8,"carbs":12,"fat":8,"serving":"1 cup (244g)"},{"name":"2% Milk","brand":"Generic","calories":122,"protein":8,"carbs":12,"fat":5,"serving":"1 cup (244g)"},{"name":"Skim Milk","brand":"Generic","calories":83,"protein":8,"carbs":12,"fat":0.2,"serving":"1 cup (244g)"},{"name":"Almond Milk, Unsweetened","brand":"Generic","calories":30,"protein":1,"carbs":1,"fat":2.5,"serving":"1 cup (240ml)"},{"name":"Black Beans, Cooked","brand":"Generic","calories":132,"protein":8.9,"carbs":24,"fat":0.5,"serving":"100g"},{"name":"Chickpeas, Cooked","brand":"Generic","calories":164,"protein":8.9,"carbs":27,"fat":2.6,"serving":"100g"},{"name":"Whole Wheat Bread","brand":"Generic","calories":81,"protein":4,"carbs":14,"fat":1.1,"serving":"1 slice"},{"name":"White Bread","brand":"Generic","calories":79,"protein":2.7,"carbs":14,"fat":1,"serving":"1 slice"},{"name":"Tortilla, Flour, Large","brand":"Generic","calories":218,"protein":6,"carbs":35,"fat":5.8,"serving":"1 large"},{"name":"Protein Powder, Whey (1 scoop)","brand":"Generic","calories":120,"protein":24,"carbs":3,"fat":1.5,"serving":"1 scoop"},{"name":"Tuna, Canned in Water","brand":"Generic","calories":116,"protein":26,"carbs":0,"fat":0.8,"serving":"1 can (165g)"},{"name":"Shrimp, Cooked","brand":"Generic","calories":99,"protein":24,"carbs":0.2,"fat":0.3,"serving":"100g"},{"name":"Turkey Breast, Roasted","brand":"Generic","calories":135,"protein":30,"carbs":0,"fat":1,"serving":"100g"},{"name":"Bacon, Cooked","brand":"Generic","calories":541,"protein":37,"carbs":1.4,"fat":42,"serving":"100g"},{"name":"Cheddar Cheese","brand":"Generic","calories":403,"protein":25,"carbs":1.3,"fat":33,"serving":"100g"},{"name":"Mozzarella Cheese","brand":"Generic","calories":280,"protein":28,"carbs":3,"fat":17,"serving":"100g"},{"name":"Brownberry Bread, Whole Grain","brand":"Brownberry","calories":80,"protein":4,"carbs":16,"fat":1,"serving":"1 slice"},{"name":"Brownberry Bread, Country White","brand":"Brownberry","calories":70,"protein":2,"carbs":13,"fat":1,"serving":"1 slice"},{"name":"Brownberry Bread, Wheat","brand":"Brownberry","calories":70,"protein":3,"carbs":13,"fat":1,"serving":"1 slice"},{"name":"Sara Lee Bread, Whole Wheat","brand":"Sara Lee","calories":60,"protein":3,"carbs":12,"fat":0.5,"serving":"1 slice"},{"name":"Nature's Own Whole Wheat Bread","brand":"Nature's Own","calories":70,"protein":3,"carbs":13,"fat":1,"serving":"1 slice"},{"name":"Wonder Bread, Classic White","brand":"Wonder","calories":70,"protein":2,"carbs":13,"fat":1,"serving":"1 slice"},{"name":"Dave's Killer Bread, 21 Grain","brand":"Dave's Killer Bread","calories":110,"protein":5,"carbs":22,"fat":1.5,"serving":"1 slice"},{"name":"Ezekiel 4:9 Bread","brand":"Food For Life","calories":80,"protein":4,"carbs":15,"fat":0.5,"serving":"1 slice"},{"name":"Kodiak Cakes Power Cakes Mix","brand":"Kodiak Cakes","calories":190,"protein":14,"carbs":31,"fat":2,"serving":"1/3 cup dry"},{"name":"Chobani Greek Yogurt, Plain","brand":"Chobani","calories":130,"protein":18,"carbs":8,"fat":4,"serving":"170g"},{"name":"Fairlife Core Power Protein Shake","brand":"Fairlife","calories":170,"protein":26,"carbs":6,"fat":4.5,"serving":"14 fl oz"},{"name":"Quest Protein Bar, Chocolate Chip Cookie Dough","brand":"Quest","calories":190,"protein":21,"carbs":21,"fat":8,"serving":"1 bar"},{"name":"Clif Bar, Chocolate Chip","brand":"Clif","calories":250,"protein":9,"carbs":44,"fat":5,"serving":"1 bar"},{"name":"RXBAR, Chocolate Sea Salt","brand":"RXBAR","calories":210,"protein":12,"carbs":24,"fat":9,"serving":"1 bar"},{"name":"Rice Krispies Treats","brand":"Kellogg's","calories":90,"protein":0.6,"carbs":17,"fat":2.5,"serving":"1 bar"},{"name":"Cheerios","brand":"General Mills","calories":100,"protein":3,"carbs":20,"fat":2,"serving":"1 cup"},{"name":"Honey Nut Cheerios","brand":"General Mills","calories":140,"protein":3,"carbs":30,"fat":1.5,"serving":"1 cup"},{"name":"Special K, Original","brand":"Kellogg's","calories":110,"protein":6,"carbs":23,"fat":0.5,"serving":"1 cup"},{"name":"Frosted Flakes","brand":"Kellogg's","calories":130,"protein":1,"carbs":31,"fat":0,"serving":"3/4 cup"},{"name":"Gatorade, Lemon Lime","brand":"Gatorade","calories":80,"protein":0,"carbs":21,"fat":0,"serving":"12 fl oz"},{"name":"Powerade, Fruit Punch","brand":"Powerade","calories":80,"protein":0,"carbs":21,"fat":0,"serving":"12 fl oz"},{"name":"Liquid IV Hydration Multiplier","brand":"Liquid IV","calories":50,"protein":0,"carbs":11,"fat":0,"serving":"1 packet"},{"name":"Skratch Labs Hydration Mix","brand":"Skratch Labs","calories":80,"protein":0,"carbs":21,"fat":0,"serving":"1 scoop"},{"name":"GU Energy Gel, Vanilla","brand":"GU","calories":100,"protein":0,"carbs":22,"fat":0,"serving":"1 packet"},{"name":"Clif Shot Bloks","brand":"Clif","calories":100,"protein":0,"carbs":24,"fat":0,"serving":"3 blocks"},{"name":"Honey Stinger Waffle","brand":"Honey Stinger","calories":150,"protein":1,"carbs":21,"fat":6,"serving":"1 waffle"},{"name":"Larabar, Cashew Cookie","brand":"Larabar","calories":200,"protein":5,"carbs":24,"fat":11,"serving":"1 bar"},{"name":"Kind Bar, Dark Chocolate Nuts & Sea Salt","brand":"Kind","calories":180,"protein":6,"carbs":16,"fat":15,"serving":"1 bar"},{"name":"Nature Valley Granola Bar, Oats 'n Honey","brand":"Nature Valley","calories":190,"protein":3,"carbs":29,"fat":7,"serving":"2 bars"},{"name":"Justin's Peanut Butter Packet","brand":"Justin's","calories":190,"protein":7,"carbs":7,"fat":16,"serving":"1 packet"},{"name":"Triscuit Crackers","brand":"Triscuit","calories":120,"protein":3,"carbs":19,"fat":4.5,"serving":"6 crackers"},{"name":"Wheat Thins","brand":"Nabisco","calories":140,"protein":2,"carbs":21,"fat":5,"serving":"16 crackers"},{"name":"Lay's Classic Potato Chips","brand":"Lay's","calories":160,"protein":2,"carbs":15,"fat":10,"serving":"1 oz"},{"name":"Doritos, Nacho Cheese","brand":"Doritos","calories":150,"protein":2,"carbs":18,"fat":8,"serving":"1 oz"},{"name":"Pringles, Original","brand":"Pringles","calories":150,"protein":1,"carbs":15,"fat":9,"serving":"14 chips"},{"name":"Skippy Peanut Butter","brand":"Skippy","calories":190,"protein":7,"carbs":7,"fat":16,"serving":"2 tbsp"},{"name":"Jif Peanut Butter","brand":"Jif","calories":190,"protein":8,"carbs":7,"fat":16,"serving":"2 tbsp"},{"name":"Nutella","brand":"Nutella","calories":200,"protein":2,"carbs":22,"fat":11,"serving":"2 tbsp"},{"name":"Hellmann's Mayonnaise","brand":"Hellmann's","calories":90,"protein":0,"carbs":0,"fat":10,"serving":"1 tbsp"},{"name":"Heinz Ketchup","brand":"Heinz","calories":20,"protein":0,"carbs":5,"fat":0,"serving":"1 tbsp"},{"name":"Frank's RedHot Sauce","brand":"Frank's","calories":0,"protein":0,"carbs":0,"fat":0,"serving":"1 tsp"},{"name":"Land O'Lakes Butter","brand":"Land O'Lakes","calories":100,"protein":0,"carbs":0,"fat":11,"serving":"1 tbsp"},{"name":"Philadelphia Cream Cheese","brand":"Philadelphia","calories":100,"protein":2,"carbs":1,"fat":10,"serving":"2 tbsp"},{"name":"Yoplait Original Yogurt, Strawberry","brand":"Yoplait","calories":150,"protein":5,"carbs":27,"fat":1.5,"serving":"6 oz"},{"name":"Activia Probiotic Yogurt","brand":"Activia","calories":110,"protein":5,"carbs":18,"fat":2,"serving":"4 oz"},{"name":"Halo Top Ice Cream, Vanilla Bean","brand":"Halo Top","calories":280,"protein":20,"carbs":48,"fat":4,"serving":"1 pint"},{"name":"Ben & Jerry's, Half Baked","brand":"Ben & Jerry's","calories":290,"protein":5,"carbs":33,"fat":16,"serving":"2/3 cup"},{"name":"Oreo Cookies","brand":"Oreo","calories":160,"protein":1,"carbs":25,"fat":7,"serving":"3 cookies"},{"name":"Chips Ahoy! Cookies","brand":"Chips Ahoy!","calories":160,"protein":1,"carbs":21,"fat":8,"serving":"3 cookies"},{"name":"Pop-Tarts, Frosted Strawberry","brand":"Pop-Tarts","calories":200,"protein":2,"carbs":38,"fat":5,"serving":"1 pastry"},{"name":"Eggo Waffles, Homestyle","brand":"Eggo","calories":180,"protein":4,"carbs":30,"fat":6,"serving":"2 waffles"},{"name":"Yoplait Greek 100 Yogurt","brand":"Yoplait","calories":100,"protein":12,"carbs":9,"fat":0,"serving":"5.3 oz"},{"name":"Premier Protein Shake, Chocolate","brand":"Premier Protein","calories":160,"protein":30,"carbs":5,"fat":3,"serving":"11 fl oz"},{"name":"Muscle Milk Protein Shake","brand":"Muscle Milk","calories":160,"protein":25,"carbs":9,"fat":4.5,"serving":"11 fl oz"},{"name":"Orgain Organic Protein Shake","brand":"Orgain","calories":150,"protein":20,"carbs":14,"fat":4,"serving":"11 fl oz"},{"name":"Vital Proteins Collagen Peptides","brand":"Vital Proteins","calories":70,"protein":18,"carbs":0,"fat":0,"serving":"2 scoops"},{"name":"Mustard, Yellow","brand":"Generic","calories":3,"protein":0.2,"carbs":0.3,"fat":0.2,"serving":"1 tsp"},{"name":"BBQ Sauce","brand":"Generic","calories":29,"protein":0.2,"carbs":7,"fat":0.1,"serving":"1 tbsp"},{"name":"Ranch Dressing","brand":"Generic","calories":73,"protein":0.1,"carbs":1,"fat":7.7,"serving":"1 tbsp"},{"name":"Italian Dressing","brand":"Generic","calories":43,"protein":0,"carbs":1.5,"fat":4,"serving":"1 tbsp"},{"name":"Balsamic Vinaigrette","brand":"Generic","calories":45,"protein":0,"carbs":3,"fat":3.5,"serving":"1 tbsp"},{"name":"Soy Sauce","brand":"Generic","calories":8,"protein":1.3,"carbs":0.8,"fat":0,"serving":"1 tbsp"},{"name":"Sriracha","brand":"Generic","calories":5,"protein":0.1,"carbs":1,"fat":0,"serving":"1 tsp"},{"name":"Honey","brand":"Generic","calories":64,"protein":0.1,"carbs":17,"fat":0,"serving":"1 tbsp"},{"name":"Maple Syrup","brand":"Generic","calories":52,"protein":0,"carbs":13,"fat":0,"serving":"1 tbsp"},{"name":"Whopper","brand":"Burger King","calories":657,"protein":28,"carbs":49,"fat":40,"serving":"1 burger"},{"name":"Whopper with Cheese","brand":"Burger King","calories":740,"protein":33,"carbs":50,"fat":47,"serving":"1 burger"},{"name":"Bacon King","brand":"Burger King","calories":1150,"protein":61,"carbs":50,"fat":79,"serving":"1 burger"},{"name":"Chicken Fries (9pc)","brand":"Burger King","calories":280,"protein":16,"carbs":19,"fat":16,"serving":"9 pieces"},{"name":"Original Chicken Sandwich","brand":"Burger King","calories":660,"protein":24,"carbs":53,"fat":39,"serving":"1 sandwich"},{"name":"Medium Fries","brand":"Burger King","calories":380,"protein":5,"carbs":49,"fat":18,"serving":"medium"},{"name":"Impossible Whopper","brand":"Burger King","calories":630,"protein":25,"carbs":58,"fat":34,"serving":"1 burger"},{"name":"Jumbo Jack","brand":"Jack in the Box","calories":690,"protein":27,"carbs":51,"fat":41,"serving":"1 burger"},{"name":"Sourdough Jack","brand":"Jack in the Box","calories":670,"protein":28,"carbs":38,"fat":44,"serving":"1 burger"},{"name":"Curly Fries (Medium)","brand":"Jack in the Box","calories":400,"protein":5,"carbs":47,"fat":21,"serving":"medium"},{"name":"Tacos (2pc)","brand":"Jack in the Box","calories":290,"protein":8,"carbs":28,"fat":16,"serving":"2 tacos"},{"name":"SuperSONIC Bacon Double Cheeseburger","brand":"Sonic","calories":920,"protein":49,"carbs":38,"fat":62,"serving":"1 burger"},{"name":"Sonic Cheeseburger","brand":"Sonic","calories":560,"protein":26,"carbs":41,"fat":33,"serving":"1 burger"},{"name":"Tots (Medium)","brand":"Sonic","calories":390,"protein":4,"carbs":47,"fat":21,"serving":"medium"},{"name":"Ocean Water (Medium)","brand":"Sonic","calories":150,"protein":0,"carbs":39,"fat":0,"serving":"medium"},{"name":"Classic Roast Beef","brand":"Arby's","calories":360,"protein":23,"carbs":37,"fat":14,"serving":"1 sandwich"},{"name":"Beef 'n Cheddar","brand":"Arby's","calories":440,"protein":23,"carbs":44,"fat":19,"serving":"1 sandwich"},{"name":"Curly Fries (Medium)","brand":"Arby's","calories":410,"protein":5,"carbs":53,"fat":20,"serving":"medium"},{"name":"Crispy Chicken Sandwich","brand":"Arby's","calories":500,"protein":24,"carbs":49,"fat":23,"serving":"1 sandwich"},{"name":"Original Recipe Chicken Breast","brand":"KFC","calories":390,"protein":39,"carbs":11,"fat":21,"serving":"1 piece"},{"name":"Original Recipe Chicken Thigh","brand":"KFC","calories":280,"protein":19,"carbs":9,"fat":19,"serving":"1 piece"},{"name":"Extra Crispy Chicken Breast","brand":"KFC","calories":470,"protein":41,"carbs":16,"fat":28,"serving":"1 piece"},{"name":"Famous Bowl","brand":"KFC","calories":700,"protein":28,"carbs":71,"fat":33,"serving":"1 bowl"},{"name":"Mashed Potatoes with Gravy","brand":"KFC","calories":130,"protein":1,"carbs":18,"fat":6,"serving":"1 side"},{"name":"Coleslaw","brand":"KFC","calories":170,"protein":1,"carbs":19,"fat":10,"serving":"1 side"},{"name":"Chicken Pot Pie","brand":"KFC","calories":770,"protein":21,"carbs":70,"fat":45,"serving":"1 pie"},{"name":"Orange Chicken","brand":"Panda Express","calories":490,"protein":25,"carbs":51,"fat":23,"serving":"1 entree"},{"name":"Beijing Beef","brand":"Panda Express","calories":470,"protein":14,"carbs":46,"fat":27,"serving":"1 entree"},{"name":"Kung Pao Chicken","brand":"Panda Express","calories":290,"protein":16,"carbs":14,"fat":19,"serving":"1 entree"},{"name":"Chow Mein","brand":"Panda Express","calories":510,"protein":13,"carbs":80,"fat":20,"serving":"1 side"},{"name":"Fried Rice","brand":"Panda Express","calories":520,"protein":11,"carbs":85,"fat":16,"serving":"1 side"},{"name":"Honey Walnut Shrimp","brand":"Panda Express","calories":430,"protein":14,"carbs":31,"fat":27,"serving":"1 entree"},{"name":"Broccoli Beef","brand":"Panda Express","calories":150,"protein":9,"carbs":13,"fat":7,"serving":"1 entree"},{"name":"White Steamed Rice","brand":"Panda Express","calories":380,"protein":7,"carbs":87,"fat":0,"serving":"1 side"},{"name":"Turkey Tom (8in)","brand":"Jimmy John's","calories":510,"protein":25,"carbs":47,"fat":23,"serving":"8 inch"},{"name":"Italian Night Club (8in)","brand":"Jimmy John's","calories":870,"protein":41,"carbs":47,"fat":59,"serving":"8 inch"},{"name":"Vito (8in)","brand":"Jimmy John's","calories":670,"protein":34,"carbs":49,"fat":38,"serving":"8 inch"},{"name":"Beach Club (8in)","brand":"Jimmy John's","calories":700,"protein":27,"carbs":47,"fat":44,"serving":"8 inch"},{"name":"Acai Berry Boost","brand":"Tropical Smoothie Cafe","calories":480,"protein":5,"carbs":99,"fat":8,"serving":"24 fl oz"},{"name":"Peanut Paradise","brand":"Tropical Smoothie Cafe","calories":720,"protein":24,"carbs":99,"fat":28,"serving":"24 fl oz"},{"name":"Sunrise Sunset Smoothie","brand":"Tropical Smoothie Cafe","calories":350,"protein":2,"carbs":88,"fat":1,"serving":"24 fl oz"},{"name":"The Hulk Strawberry","brand":"Smoothie King","calories":1240,"protein":51,"carbs":156,"fat":47,"serving":"20 fl oz"},{"name":"Gladiator Strawberry","brand":"Smoothie King","calories":380,"protein":30,"carbs":60,"fat":3,"serving":"20 fl oz"},{"name":"Slim-N-Trim Strawberry","brand":"Smoothie King","calories":220,"protein":21,"carbs":33,"fat":1,"serving":"20 fl oz"},{"name":"Blizzard, Oreo (Medium)","brand":"Dairy Queen","calories":710,"protein":13,"carbs":100,"fat":28,"serving":"medium"},{"name":"Soft Serve Cone, Vanilla (Medium)","brand":"Dairy Queen","calories":330,"protein":8,"carbs":53,"fat":9,"serving":"medium"},{"name":"GrillBurger (Original)","brand":"Dairy Queen","calories":480,"protein":24,"carbs":39,"fat":26,"serving":"1 burger"},{"name":"Pork Chop, Grilled","brand":"Generic","calories":231,"protein":25,"carbs":0,"fat":14,"serving":"100g"},{"name":"Pork Tenderloin, Roasted","brand":"Generic","calories":143,"protein":26,"carbs":0,"fat":3.5,"serving":"100g"},{"name":"Turkey Bacon","brand":"Generic","calories":109,"protein":13,"carbs":1,"fat":6,"serving":"3 slices"},{"name":"Steak, Sirloin, Grilled","brand":"Generic","calories":207,"protein":26,"carbs":0,"fat":11,"serving":"100g"},{"name":"Steak, Ribeye, Grilled","brand":"Generic","calories":291,"protein":24,"carbs":0,"fat":21,"serving":"100g"},{"name":"Cod, Baked","brand":"Generic","calories":105,"protein":23,"carbs":0,"fat":0.9,"serving":"100g"},{"name":"Tofu, Firm","brand":"Generic","calories":144,"protein":15,"carbs":3,"fat":8,"serving":"100g"},{"name":"Edamame, Cooked","brand":"Generic","calories":121,"protein":11,"carbs":10,"fat":5,"serving":"100g"},{"name":"Lentils, Cooked","brand":"Generic","calories":116,"protein":9,"carbs":20,"fat":0.4,"serving":"100g"},{"name":"Hummus","brand":"Generic","calories":166,"protein":8,"carbs":14,"fat":10,"serving":"100g"},{"name":"Walnuts","brand":"Generic","calories":654,"protein":15,"carbs":14,"fat":65,"serving":"100g"},{"name":"Cashews","brand":"Generic","calories":553,"protein":18,"carbs":30,"fat":44,"serving":"100g"},{"name":"Pistachios","brand":"Generic","calories":562,"protein":20,"carbs":28,"fat":45,"serving":"100g"},{"name":"Pecans","brand":"Generic","calories":691,"protein":9,"carbs":14,"fat":72,"serving":"100g"},{"name":"Chia Seeds","brand":"Generic","calories":486,"protein":17,"carbs":42,"fat":31,"serving":"100g"},{"name":"Flaxseed, Ground","brand":"Generic","calories":534,"protein":18,"carbs":29,"fat":42,"serving":"100g"},{"name":"Blueberries","brand":"Generic","calories":57,"protein":0.7,"carbs":14,"fat":0.3,"serving":"100g"},{"name":"Strawberries","brand":"Generic","calories":32,"protein":0.7,"carbs":7.7,"fat":0.3,"serving":"100g"},{"name":"Raspberries","brand":"Generic","calories":52,"protein":1.2,"carbs":12,"fat":0.7,"serving":"100g"},{"name":"Grapes","brand":"Generic","calories":69,"protein":0.7,"carbs":18,"fat":0.2,"serving":"100g"},{"name":"Orange, Medium","brand":"Generic","calories":62,"protein":1.2,"carbs":15,"fat":0.2,"serving":"1 medium"},{"name":"Pineapple, Chunks","brand":"Generic","calories":50,"protein":0.5,"carbs":13,"fat":0.1,"serving":"100g"},{"name":"Mango","brand":"Generic","calories":60,"protein":0.8,"carbs":15,"fat":0.4,"serving":"100g"},{"name":"Watermelon","brand":"Generic","calories":30,"protein":0.6,"carbs":7.6,"fat":0.2,"serving":"100g"},{"name":"Carrots, Raw","brand":"Generic","calories":41,"protein":0.9,"carbs":10,"fat":0.2,"serving":"100g"},{"name":"Bell Pepper, Raw","brand":"Generic","calories":31,"protein":1,"carbs":6,"fat":0.3,"serving":"100g"},{"name":"Cucumber, Raw","brand":"Generic","calories":15,"protein":0.7,"carbs":3.6,"fat":0.1,"serving":"100g"},{"name":"Tomato, Raw","brand":"Generic","calories":18,"protein":0.9,"carbs":3.9,"fat":0.2,"serving":"100g"},{"name":"Onion, Raw","brand":"Generic","calories":40,"protein":1.1,"carbs":9.3,"fat":0.1,"serving":"100g"},{"name":"Asparagus, Steamed","brand":"Generic","calories":22,"protein":2.4,"carbs":4.1,"fat":0.2,"serving":"100g"},{"name":"Brussels Sprouts, Roasted","brand":"Generic","calories":43,"protein":3.4,"carbs":9,"fat":0.3,"serving":"100g"},{"name":"Cauliflower, Steamed","brand":"Generic","calories":23,"protein":1.8,"carbs":4.1,"fat":0.5,"serving":"100g"},{"name":"Green Beans, Steamed","brand":"Generic","calories":35,"protein":1.9,"carbs":8,"fat":0.2,"serving":"100g"},{"name":"Corn, Boiled","brand":"Generic","calories":96,"protein":3.4,"carbs":21,"fat":1.5,"serving":"100g"},{"name":"Pasta, Cooked","brand":"Generic","calories":158,"protein":5.8,"carbs":31,"fat":0.9,"serving":"100g"},{"name":"Whole Wheat Pasta, Cooked","brand":"Generic","calories":124,"protein":5.3,"carbs":26,"fat":0.5,"serving":"100g"},{"name":"Bagel, Plain","brand":"Generic","calories":245,"protein":9.4,"carbs":48,"fat":1.4,"serving":"1 bagel"},{"name":"English Muffin","brand":"Generic","calories":134,"protein":4.4,"carbs":26,"fat":1,"serving":"1 muffin"},{"name":"Tortilla Chips","brand":"Generic","calories":489,"protein":7,"carbs":65,"fat":23,"serving":"100g"},{"name":"Popcorn, Air-Popped","brand":"Generic","calories":387,"protein":13,"carbs":78,"fat":4.5,"serving":"100g"},{"name":"Dark Chocolate, 70-85%","brand":"Generic","calories":598,"protein":7.8,"carbs":46,"fat":43,"serving":"100g"},{"name":"Milk Chocolate","brand":"Generic","calories":535,"protein":7.7,"carbs":59,"fat":30,"serving":"100g"},{"name":"Beer, Light (12oz)","brand":"Generic","calories":103,"protein":0.9,"carbs":6,"fat":0,"serving":"12 fl oz"},{"name":"Beer, Regular (12oz)","brand":"Generic","calories":153,"protein":1.6,"carbs":13,"fat":0,"serving":"12 fl oz"},{"name":"Beer, IPA (12oz)","brand":"Generic","calories":198,"protein":1.6,"carbs":18,"fat":0,"serving":"12 fl oz"},{"name":"Wine, Red (5oz)","brand":"Generic","calories":125,"protein":0.1,"carbs":4,"fat":0,"serving":"5 fl oz"},{"name":"Wine, White (5oz)","brand":"Generic","calories":121,"protein":0.1,"carbs":3.8,"fat":0,"serving":"5 fl oz"},{"name":"Vodka (1.5oz)","brand":"Generic","calories":97,"protein":0,"carbs":0,"fat":0,"serving":"1.5 fl oz"},{"name":"White Claw Hard Seltzer","brand":"White Claw","calories":100,"protein":0,"carbs":2,"fat":0,"serving":"12 fl oz"},{"name":"Caribou Coffee, Medium Black","brand":"Caribou Coffee","calories":5,"protein":0,"carbs":1,"fat":0,"serving":"medium"},{"name":"Caribou Cooler","brand":"Caribou Coffee","calories":270,"protein":1,"carbs":65,"fat":0.5,"serving":"medium"},{"name":"Caribou Mocha (Medium)","brand":"Caribou Coffee","calories":320,"protein":9,"carbs":47,"fat":12,"serving":"medium"},{"name":"Costco Polish Hot Dog","brand":"Costco","calories":480,"protein":17,"carbs":35,"fat":30,"serving":"1 hot dog"},{"name":"Costco Pizza Slice, Cheese","brand":"Costco","calories":700,"protein":30,"carbs":78,"fat":27,"serving":"1 slice"},{"name":"Costco Chicken Bake","brand":"Costco","calories":770,"protein":32,"carbs":73,"fat":39,"serving":"1 item"},{"name":"Costco Churro","brand":"Costco","calories":320,"protein":4,"carbs":36,"fat":18,"serving":"1 churro"},{"name":"Sandwich Thins, Whole Wheat","brand":"Brownberry","calories":100,"protein":5,"carbs":21,"fat":1,"serving":"1 thin"},{"name":"Sandwich Thins, Multi-Grain","brand":"Brownberry","calories":100,"protein":5,"carbs":20,"fat":1.5,"serving":"1 thin"},{"name":"Sandwich Thins, 100% Whole Wheat","brand":"Brownberry","calories":100,"protein":5,"carbs":21,"fat":1,"serving":"1 thin"},{"name":"Bagel Thins, Plain","brand":"Brownberry","calories":110,"protein":5,"carbs":22,"fat":0.5,"serving":"1 bagel thin"},{"name":"Bagel Thins, Everything","brand":"Brownberry","calories":110,"protein":5,"carbs":22,"fat":1,"serving":"1 bagel thin"}];

  function normalizeQ(s) {
    return s.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function stripPlural(s) {
    return s.replace(/(ies)$/, 'y').replace(/(es)$/, '').replace(/s$/, '');
  }
  function fuzzyTokenMatch(query, target) {
    const qTokens = normalizeQ(query).split(' ').filter(Boolean);
    const tTokens = normalizeQ(target).split(' ').filter(Boolean);
    return qTokens.every(qt => {
      const qtSing = stripPlural(qt);
      return tTokens.some(tt => {
        const ttSing = stripPlural(tt);
        return tt.indexOf(qt) === 0 || qt.indexOf(tt) === 0 || ttSing === qtSing || tt.indexOf(qtSing) === 0;
      });
    });
  }
  function searchLocalFoods(query) {
    const qNorm = normalizeQ(query);
    if (!qNorm) return [];
    const scored = LOCAL_FOODS.map(f => {
      const nameNorm = normalizeQ(f.name);
      const brandNorm = normalizeQ(f.brand);
      const full = nameNorm + ' ' + brandNorm;
      let score = 0;
      if (nameNorm === qNorm) score = 100;
      else if (nameNorm.indexOf(qNorm) === 0) score = 90;
      else if (brandNorm.indexOf(qNorm) === 0) score = 85;
      else if (nameNorm.indexOf(qNorm) !== -1) score = 70;
      else if (brandNorm.indexOf(qNorm) !== -1) score = 65;
      else if (fuzzyTokenMatch(query, full)) score = 50;
      return { food: f, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 25);
    return scored.map(x => ({
      n: x.food.name + (x.food.brand && x.food.brand !== 'Generic' ? ' - ' + x.food.brand : ''),
      cal: x.food.calories, p: x.food.protein, c: x.food.carbs, f: x.food.fat,
      srv: x.food.serving
    }));
  }

  const q = url.searchParams.get('q')
  if (!q) return new Response(JSON.stringify({foods:[]}), {headers})
  try {
    const localResults = searchLocalFoods(q);

    if (localResults.length >= 5) {
      return new Response(JSON.stringify({foods: localResults}), {headers})
    }

    const usdaUrl = 'https://api.nal.usda.gov/fdc/v1/foods/search?query=' + encodeURIComponent(q)
      + '&pageSize=20&sortBy=score&sortOrder=desc&dataType=Branded,Foundation,SR%20Legacy'
      + '&api_key=bC38HIShNhDzbFJH9jQUa6HgGFLKzMeeHNrhEeUB'

    const usdaRes = await fetch(usdaUrl)

    let foods = localResults.slice()

    if (usdaRes.ok) {
      const usdaData = await usdaRes.json()
      const usdaFoods = (usdaData.foods||[]).map(p => {
        let cal=0,pro=0,carb=0,fat=0,fiber=0,sugar=0,sodium=0,satFat=0
        ;(p.foodNutrients||[]).forEach(n => {
          const id=n.nutrientId||n.nutrientNumber, v=n.value||0
          if(id==1008||id=='208') cal=Math.round(v)
          else if(id==1003||id=='203') pro=Math.round(v*10)/10
          else if(id==1005||id=='205') carb=Math.round(v*10)/10
          else if(id==1004||id=='204') fat=Math.round(v*10)/10
          else if(id==1079||id=='291') fiber=Math.round(v*10)/10
          else if(id==2000||id=='269') sugar=Math.round(v*10)/10
          else if(id==1093||id=='307') sodium=Math.round(v)
          else if(id==1258||id=='606') satFat=Math.round(v*10)/10
        })
        if(!cal && p.dataType==='Branded') return null
        const brand = (p.brandOwner||p.brandName||'').split(',')[0].trim()
        const srv = p.servingSize ? Math.round(p.servingSize)+(p.servingSizeUnit||'g') : '1 serving'
        return {n:p.description+(brand?' - '+brand:''), cal, p:pro, c:carb, f:fat, fiber, sugar, sodium, satFat, srv}
      }).filter(Boolean)
      foods = foods.concat(usdaFoods)
    }

    const seen = new Set()
    const deduped = foods.filter(f => {
      const key = f.n.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,25)
      if(seen.has(key)) return false
      seen.add(key); return true
    })

    return new Response(JSON.stringify({foods: deduped.slice(0,25)}), {headers})
  } catch(e) {
    return new Response(JSON.stringify({foods:[], error: e.message}), {headers})
  }
  }
};
