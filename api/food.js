addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  const q = url.searchParams.get('q')
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  }
  if (!q) return new Response(JSON.stringify({foods:[]}), {headers})
  try {
    const r = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&pageSize=25&dataType=Branded,Survey%20(FNDDS)&api_key=DEMO_KEY`)
    const data = await r.json()
    const foods = (data.foods||[]).map(p => {
      let cal=0,pro=0,carb=0,fat=0
      ;(p.foodNutrients||[]).forEach(n => {
        if(n.nutrientId===1008) cal=Math.round(n.value||0)
        else if(n.nutrientId===1003) pro=Math.round((n.value||0)*10)/10
        else if(n.nutrientId===1005) carb=Math.round((n.value||0)*10)/10
        else if(n.nutrientId===1004) fat=Math.round((n.value||0)*10)/10
      })
      if(!cal) return null
      return {n:p.description+(p.brandOwner?' · '+p.brandOwner.split(',')[0]:''),cal,p:pro,c:carb,f:fat,srv:p.servingSize?p.servingSize+(p.servingSizeUnit||'g'):'1 serving'}
    }).filter(Boolean)
    return new Response(JSON.stringify({foods}), {headers})
  } catch(e) {
    return new Response(JSON.stringify({foods:[],error:e.message}), {headers})
  }
}
