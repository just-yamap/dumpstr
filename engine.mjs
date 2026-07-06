// DUMPSTR DEPEG ENGINE v3 — Jupiter Price API (1 call all coins), position-safe, permanent trade log.
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';

function loadEnv(){try{const t=fs.readFileSync(new URL('./.env',import.meta.url),'utf8');for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);if(m)process.env[m[1]]=m[2];}}catch{}}
loadEnv();
const HELIUS_KEY=process.env.HELIUS_KEY||'';
const JUP_KEY=process.env.JUP_KEY||'';
const jupHeaders=JUP_KEY?{'x-api-key':JUP_KEY}:{};

const CFG={
  PORT:Number(process.env.PORT||8787),
  START_USD:Number(process.env.CAPITAL||10000),
  POS_PCT:Number(process.env.POS_PCT||20)/100,
  MAX_POSITIONS:Number(process.env.MAX_POS||5),
  DEPEG_BPS:Number(process.env.DEPEG_BPS||15)/10000,
  SELL_BPS:Number(process.env.SELL_BPS||5)/10000,
  CYCLE_MS:Number(process.env.CYCLE_MS||5000),
  COST_EST:Number(process.env.COST_EST||0.1)/100,
  SHORT:process.env.SHORT==='true',
};
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STABLES=[
  {sym:'USDC',mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'},
  {sym:'USDT',mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'},
  {sym:'PYUSD',mint:'2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'},
  {sym:'USDS',mint:'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA'},
  {sym:'FDUSD',mint:'9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u'},
  {sym:'USDe',mint:'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT'},
  {sym:'AUSD',mint:'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9'},
  {sym:'USDG',mint:'2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'},
];
const MINTS=STABLES.map(s=>s.mint).join(',');
const BYMINT=Object.fromEntries(STABLES.map(s=>[s.mint,s.sym]));

const LEDGER_FILE=new URL('./trades.json',import.meta.url);
function loadTrades(){try{return JSON.parse(fs.readFileSync(LEDGER_FILE,'utf8'));}catch{return{sinceInception:null,trades:[],realizedPnl:0,wins:0,losses:0};}}
function saveTrades(l){try{fs.writeFileSync(LEDGER_FILE,JSON.stringify(l,null,2));}catch(e){console.error('save fail',e.message);}}
const ledger=loadTrades();
if(!ledger.sinceInception)ledger.sinceInception=new Date().toISOString();

const S={
  mode:'PAPER',started:Date.now(),cycle:0,rpc:HELIUS_KEY?'HELIUS':'public',jup:JUP_KEY?'KEYED':'keyless',
  cfg:{capital:CFG.START_USD,posPct:CFG.POS_PCT,maxPos:CFG.MAX_POSITIONS,depeg:CFG.DEPEG_BPS,sell:CFG.SELL_BPS,cost:CFG.COST_EST},
  portfolio:{cash:CFG.START_USD,deployed:0,equity:CFG.START_USD,realizedPnl:ledger.realizedPnl||0,startCapital:CFG.START_USD,roi:0},
  stables:[],positions:[],poolMap:{},trades:ledger.trades.slice(0,40),log:[],
  stats:{signals:0,trades:ledger.trades.length,wins:ledger.wins||0,losses:ledger.losses||0,rateLimitHits:0,sinceInception:ledger.sinceInception},
  lastEvent:null,lastPrices:{},
};
const ts=()=>new Date().toISOString().slice(11,19);
const push=(m,cls='')=>{S.log.unshift({t:ts(),m,cls});S.log=S.log.slice(0,150);console.log(`[${ts()}] ${m}`);};

async function jfetch(url,opts={},tries=3){for(let i=0;i<tries;i++){try{const r=await fetch(url,{...opts,headers:{...jupHeaders,...(opts.headers||{})},signal:AbortSignal.timeout(12000)});if(r.status===429){S.stats.rateLimitHits++;await sleep(3000*(i+1));continue;}if(r.ok)return await r.json();}catch{}await sleep(600*(i+1));}return null;}

async function fetchPrices(){
  const d=await jfetch(`https://api.jup.ag/price/v3?ids=${MINTS}`);
  if(!d)return null;
  const out={};
  for(const [mint,info] of Object.entries(d)){if(info?.usdPrice)out[BYMINT[mint]]=info.usdPrice;}
  return out;
}
async function poolsFor(mint){const d=await jfetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);return (d?.data||[]).map(p=>({name:p.attributes?.name?.slice(0,18)||'?',liq:Math.round(Number(p.attributes?.reserve_in_usd||0))})).filter(p=>p.liq>1000).sort((a,b)=>b.liq-a.liq).slice(0,3);}

const positions=new Map();
async function scan(){
  const prices=await fetchPrices();
  const out=[];
  for(const s of STABLES){
    let price=prices?.[s.sym];
    if(price==null && positions.has(s.sym)) price=S.lastPrices[s.sym];
    if(price==null){out.push({sym:s.sym,price:null,stale:positions.has(s.sym)});continue;}
    S.lastPrices[s.sym]=price;
    const dev=price-1;
    if(Math.abs(dev)>0.05){out.push({sym:s.sym,price,dev:null,bad:true});continue;}
    const cost=CFG.COST_EST;
    const edge=Math.abs(dev)-cost;
    const pos=positions.get(s.sym);
    if(!pos && dev<0 && Math.abs(dev)>=CFG.DEPEG_BPS && edge>0 && positions.size<CFG.MAX_POSITIONS){
      const size=Math.min(S.portfolio.cash,S.portfolio.startCapital*CFG.POS_PCT);
      if(size>=10){
        positions.set(s.sym,{side:'long',entry:price,sizeUSD:size,cost,openedAt:Date.now()});
        S.portfolio.cash-=size;S.portfolio.deployed+=size;S.stats.signals++;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`BUY ${s.sym} @ ${price.toFixed(5)} | $${size.toFixed(2)} (${(CFG.POS_PCT*100)}%) | ${(dev*100).toFixed(3)}% cheap, edge +${(edge*100).toFixed(3)}% | target ${(1-CFG.SELL_BPS).toFixed(5)}`,'ok');
      }
    }
    if(!pos && CFG.SHORT && dev>0 && Math.abs(dev)>=CFG.DEPEG_BPS && edge>0 && positions.size<CFG.MAX_POSITIONS){
      const size=Math.min(S.portfolio.cash,S.portfolio.startCapital*CFG.POS_PCT);
      if(size>=10){
        positions.set(s.sym,{side:'short',entry:price,sizeUSD:size,cost,openedAt:Date.now()});
        S.portfolio.cash-=size;S.portfolio.deployed+=size;S.stats.signals++;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`SHORT ${s.sym} @ ${price.toFixed(5)} | $${size.toFixed(2)} | ${(dev*100).toFixed(3)}% rich, edge +${(edge*100).toFixed(3)}% | target ${(1+CFG.SELL_BPS).toFixed(5)} [paper-sim, live needs inventory]`,'warn');
      }
    }
    if(pos && pos.side==='short' && price<=(1+CFG.SELL_BPS)){
      const netPct=(pos.entry-price)-pos.cost;
      const pnl=netPct*pos.sizeUSD;const roi=netPct*100;
      S.portfolio.cash+=pos.sizeUSD+pnl;S.portfolio.deployed-=pos.sizeUSD;S.portfolio.realizedPnl+=pnl;
      S.stats.trades++;pnl>=0?S.stats.wins++:S.stats.losses++;
      const held=((Date.now()-pos.openedAt)/1000).toFixed(0);
      const trade={sym:s.sym,entry:pos.entry,exit:price,sizeUSD:pos.sizeUSD,pnl,roi,held,t:ts(),date:new Date().toISOString(),side:'short'};
      S.trades.unshift(trade);S.trades=S.trades.slice(0,40);
      ledger.trades.unshift(trade);ledger.realizedPnl=S.portfolio.realizedPnl;ledger.wins=S.stats.wins;ledger.losses=S.stats.losses;saveTrades(ledger);
      S.lastEvent={type:'SELL',sym:s.sym,pnl,at:Date.now()};
      push(`COVER ${s.sym} @ ${price.toFixed(5)} | entry ${pos.entry.toFixed(5)} | $${pos.sizeUSD.toFixed(2)} | held ${held}s | PROFIT ${pnl>=0?'+':''}$${pnl.toFixed(2)} | ROI ${roi>=0?'+':''}${roi.toFixed(3)}% [logged]`,pnl>=0?'ok':'err');
      positions.delete(s.sym);
    }
    if(pos && pos.side==='long' && price>=(1-CFG.SELL_BPS)){
      const netPct=(price-pos.entry)-pos.cost;
      const pnl=netPct*pos.sizeUSD;const roi=netPct*100;
      S.portfolio.cash+=pos.sizeUSD+pnl;S.portfolio.deployed-=pos.sizeUSD;S.portfolio.realizedPnl+=pnl;
      S.stats.trades++;pnl>=0?S.stats.wins++:S.stats.losses++;
      const held=((Date.now()-pos.openedAt)/1000).toFixed(0);
      const trade={sym:s.sym,entry:pos.entry,exit:price,sizeUSD:pos.sizeUSD,pnl,roi,held,t:ts(),date:new Date().toISOString()};
      S.trades.unshift(trade);S.trades=S.trades.slice(0,40);
      ledger.trades.unshift(trade);ledger.realizedPnl=S.portfolio.realizedPnl;ledger.wins=S.stats.wins;ledger.losses=S.stats.losses;saveTrades(ledger);
      S.lastEvent={type:'SELL',sym:s.sym,pnl,at:Date.now()};
      push(`SELL ${s.sym} @ ${price.toFixed(5)} | entry ${pos.entry.toFixed(5)} | $${pos.sizeUSD.toFixed(2)} | held ${held}s | PROFIT ${pnl>=0?'+':''}$${pnl.toFixed(2)} | ROI ${roi>=0?'+':''}${roi.toFixed(3)}% [logged]`,pnl>=0?'ok':'err');
      positions.delete(s.sym);
    }
    const p=positions.get(s.sym);
    out.push({sym:s.sym,price,dev,cost,edge,alert:Math.abs(dev)>=CFG.DEPEG_BPS&&edge>0&&(dev<0||(CFG.SHORT&&dev>0)),rich:dev>0,
      holding:!!p,entry:p?.entry,sizeUSD:p?.sizeUSD,unrealPnl:p?(price-p.entry)*p.sizeUSD:null});
  }
  S.stables=out;
  S.portfolio.equity=S.portfolio.cash+S.portfolio.deployed;
  S.portfolio.roi=((S.portfolio.equity+S.portfolio.realizedPnl-S.portfolio.startCapital)/S.portfolio.startCapital)*100;
  S.positions=[...positions.entries()].map(([sym,p])=>{const cur=S.lastPrices[sym]||p.entry;return{sym,side:p.side,entry:p.entry,sizeUSD:p.sizeUSD,cur,target:1-CFG.SELL_BPS,age:Math.round((Date.now()-p.openedAt)/1000),unrealPnl:(cur-p.entry)*p.sizeUSD};});
}
async function refreshPools(){S.poolMap=S.poolMap||{};for(const s of STABLES){S.poolMap[s.sym]=await poolsFor(s.mint);await sleep(400);}}

const DASH=fs.existsSync(new URL('./dashboard.html',import.meta.url))?fs.readFileSync(new URL('./dashboard.html',import.meta.url),'utf8'):'<h1>dashboard.html missing</h1>';
http.createServer((req,res)=>{
  if(req.url.startsWith('/state')){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(S));}
  else if(req.url.startsWith('/stats')){
    const summary={sinceInception:S.stats.sinceInception,totalTrades:S.stats.trades,wins:S.stats.wins,losses:S.stats.losses,winRate:S.stats.trades?(S.stats.wins/S.stats.trades*100).toFixed(1)+'%':'n/a',realizedPnl:'$'+S.portfolio.realizedPnl.toFixed(2),roi:S.portfolio.roi.toFixed(3)+'%',equity:'$'+(S.portfolio.equity+S.portfolio.realizedPnl).toFixed(2),openPositions:S.positions.length,rateLimitHits:S.stats.rateLimitHits,cyclesRun:S.cycle,recentTrades:S.trades.slice(0,10)};
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(summary,null,2));}
  else{res.writeHead(200,{'Content-Type':'text/html'});res.end(DASH);}
}).listen(CFG.PORT,()=>push(`cockpit live -> http://localhost:${CFG.PORT} · stats at /stats`,'ok'));

push(`DUMPSTR DEPEG ENGINE v3 · PAPER · $${CFG.START_USD} · Jupiter ${S.jup} · ${STABLES.length} coins/call · buy@${(CFG.DEPEG_BPS*100).toFixed(2)}% sell@${(CFG.SELL_BPS*100).toFixed(2)}%`);
push(`lifetime: ${ledger.trades.length} trades · $${(ledger.realizedPnl||0).toFixed(2)} realized since ${ledger.sinceInception?.slice(0,10)}`,'ok');
await refreshPools();let lastPools=Date.now();
while(true){
  S.cycle++;
  await scan();
  push(`cycle ${S.cycle}: equity $${S.portfolio.equity.toFixed(2)} · realized $${S.portfolio.realizedPnl.toFixed(2)} · ROI ${S.portfolio.roi.toFixed(3)}% · ${S.positions.length} open · ${S.stats.trades} lifetime · 429s:${S.stats.rateLimitHits}`);
  if(Date.now()-lastPools>3*60000){await refreshPools();lastPools=Date.now();}
  await sleep(CFG.CYCLE_MS);
}
