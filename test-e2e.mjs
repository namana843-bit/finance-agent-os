const base='http://localhost:4132';
await new Promise(r=>setTimeout(r,6000));
console.log('=== HEALTH ===');
try{ const t=await fetch(base+'/api/health').then(r=>r.text()); console.log(t.slice(0,400)); }catch(e){console.error(e);}
console.log('=== STATE ===');
try{ const j=await fetch(base+'/api/state').then(r=>r.json()); console.log('channels',j.channels?.length,'events',j.recentEvents?.length); console.log(j.recentEvents?.slice(-8).map(e=>e.type+' '+JSON.stringify(e.data).slice(0,120)).join('\n')); }catch(e){console.error(e);}
console.log('=== PORTFOLIO ===');
try{ const j=await fetch(base+'/api/portfolio').then(r=>r.json()); console.log(JSON.stringify(j).slice(0,800)); }catch(e){console.error(e);}
console.log('=== TICKS ===');
try{ const j=await fetch(base+'/api/market/ticks?limit=3').then(r=>r.json()); console.log(JSON.stringify(j).slice(0,600)); }catch(e){console.error(e);}
