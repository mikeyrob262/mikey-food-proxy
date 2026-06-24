addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  }

  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {headers: {...headers, 'Access-Control-Allow-Headers': 'Authorization, Content-Type'}})
  }

  // ── CLAUDE API PROXY ─────────────────────────────────────────────────────
  if (url.pathname.endsWith('/claude')) {
    try {
      const body = await request.json()
      const apiKey = typeof ANTHROPIC_API_KEY !== 'undefined' ? ANTHROPIC_API_KEY : ''
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
  const action = url.searchParams.get('action')
  if (action === 'intervals_sync') {
    const athleteId = url.searchParams.get('athlete') || 'i544205'
    const apiKey = url.searchParams.get('key')
    const oldest = url.searchParams.get('oldest') || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10)
    if (!apiKey) return new Response(JSON.stringify({error:'No API key'}), {headers})
    try {
      const auth = btoa('API_KEY:' + apiKey)
      const iUrl = `https://intervals.icu/api/v1/athlete/${athleteId}/activities?oldest=${oldest}&limit=200`
      const res = await fetch(iUrl, {headers: {'Authorization': 'Basic ' + auth}})
      if (!res.ok) return new Response(JSON.stringify({error:'Intervals.icu error: '+res.status}), {headers})
      const data = await res.json()
      return new Response(JSON.stringify({activities: data}), {headers})
    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {headers})
    }
  }

  // ── FOOD SEARCH ──────────────────────────────────────────────────────────
  const q = url.searchParams.get('q')
  if (!q) return new Response(JSON.stringify({foods:[]}), {headers})

  try {
    const usdaUrl = 'https://api.nal.usda.gov/fdc/v1/foods/search?query=' + encodeURIComponent(q) + '&pageSize=20&dataType=Branded,Survey%20(FNDDS)&api_key=bC38HIShNhDzbFJH9jQUa6HgGFLKzMeeHNrhEeUB'
    const offUrl = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q) + '&search_simple=1&action=process&json=1&page_size=15&fields=product_name,brands,nutriments,serving_size'

    const [usdaRes, offRes] = await Promise.allSettled([fetch(usdaUrl), fetch(offUrl)])

    let foods = []

    if (usdaRes.status === 'fulfilled' && usdaRes.value.ok) {
      const data = await usdaRes.value.json()
      const usdaFoods = (data.foods||[]).map(p => {
        let cal=0,pro=0,carb=0,fat=0,fiber=0,satFat=0,sodium=0,sugar=0
        ;(p.foodNutrients||[]).forEach(n => {
          if(n.nutrientId===1008) cal=Math.round(n.value||0)
          else if(n.nutrientId===1003) pro=Math.round((n.value||0)*10)/10
          else if(n.nutrientId===1005) carb=Math.round((n.value||0)*10)/10
          else if(n.nutrientId===1004) fat=Math.round((n.value||0)*10)/10
          else if(n.nutrientId===1079) fiber=Math.round((n.value||0)*10)/10
          else if(n.nutrientId===1258) satFat=Math.round((n.value||0)*10)/10
          else if(n.nutrientId===1093) sodium=Math.round(n.value||0)
          else if(n.nutrientId===2000) sugar=Math.round((n.value||0)*10)/10
        })
        if(!cal) return null
        return {
          n: p.description + (p.brandOwner?' - '+p.brandOwner.split(',')[0]:''),
          cal, p:pro, c:carb, f:fat, fiber, satFat, sodium, sugar,
          srv: p.servingSize ? p.servingSize+(p.servingSizeUnit||'g') : '1 serving'
        }
      }).filter(Boolean)
      foods = foods.concat(usdaFoods)
    }

    if (offRes.status === 'fulfilled' && offRes.value.ok) {
      const offData = await offRes.value.json()
      const offFoods = (offData.products||[]).map(p => {
        const name = (p.product_name||'').trim()
        const brand = (p.brands||'').split(',')[0].trim()
        if(!name) return null
        const nu = p.nutriments || {}
        const cal = Math.round(nu['energy-kcal_serving'] || nu['energy-kcal_100g'] || 0)
        if(!cal) return null
        return {
          n: brand ? name + ' - ' + brand : name,
          cal,
          p: Math.round((nu['proteins_serving'] || nu['proteins_100g'] || 0)*10)/10,
          c: Math.round((nu['carbohydrates_serving'] || nu['carbohydrates_100g'] || 0)*10)/10,
          f: Math.round((nu['fat_serving'] || nu['fat_100g'] || 0)*10)/10,
          fiber: Math.round((nu['fiber_serving'] || nu['fiber_100g'] || 0)*10)/10,
          satFat: Math.round((nu['saturated-fat_serving'] || nu['saturated-fat_100g'] || 0)*10)/10,
          sodium: Math.round(nu['sodium_serving'] || nu['sodium_100g'] || 0),
          sugar: Math.round((nu['sugars_serving'] || nu['sugars_100g'] || 0)*10)/10,
          srv: p.serving_size || '1 serving'
        }
      }).filter(Boolean)
      foods = foods.concat(offFoods)
    }

    const seen = new Set()
    foods = foods.filter(f => {
      const key = f.n.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,25)
      if(seen.has(key)) return false
      seen.add(key)
      return true
    })

    return new Response(JSON.stringify({foods: foods.slice(0,35)}), {headers})
  } catch(e) {
    return new Response(JSON.stringify({foods:[], error:e.message}), {headers})
  }
}
