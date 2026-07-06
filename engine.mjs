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
  COST_EST:Number(process.env.COST_EST||0.1)/100, // est round-trip cost (0.1%)
  SHORT:process.env.SHORT==='true', // enable shorting over-pegged coins (paper: simulated)
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
  {sym:'USD1',mint:'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB'},
];
// Which coins can actually be BORROWED to short (Solana lending markets). Small-caps can't be.
const BORROWABLE={USDC:true,USDT:true,USDe:true,PYUSD:true,USDS:true,FDUSD:false,AUSD:false,USDG:false,USD1:false};
const MINTS=STABLES.map(s=>s.mint).join(',');
const BYMINT=Object.fromEntries(STABLES.map(s=>[s.mint,s.sym]));

// ---- Persistent trade log (survives restarts) ----
const LEDGER_FILE=new URL('./trades.json',import.meta.url);
function loadTrades(){try{return JSON.parse(fs.readFileSync(LEDGER_FILE,'utf8'));}catch{return{sinceInception:null,trades:[],realizedPnl:0,wins:0,losses:0};}}
function saveTrades(l){try{fs.writeFileSync(LEDGER_FILE,JSON.stringify(l,null,2));}catch(e){console.error('save fail',e.message);}}
const ledger=loadTrades();
if(!ledger.sinceInception)ledger.sinceInception=new Date().toISOString();

const S={
  mode:'PAPER',started:Date.now(),cycle:0,rpc:HELIUS_KEY?'HELIUS':'public',jup:JUP_KEY?'KEYED':'keyless',
  cfg:{capital:CFG.START_USD,posPct:CFG.POS_PCT,maxPos:CFG.MAX_POSITIONS,depeg:CFG.DEPEG_BPS,sell:CFG.SELL_BPS,cost:CFG.COST_EST},
  portfolio:{cash:CFG.START_USD,deployed:0,equity:CFG.START_USD,realizedPnl:ledger.realizedPnl||0,startCapital:CFG.START_USD,roi:0},
  stables:[],positions:[],poolMap:{},trades:ledger.trades.slice(0,40),log:[],cex:{},gecko:[],
  stats:{signals:0,trades:ledger.trades.length,wins:ledger.wins||0,losses:ledger.losses||0,rateLimitHits:0,sinceInception:ledger.sinceInception},
  lastEvent:null,lastPrices:{},equityHistory:[],
};
const ts=()=>new Date().toISOString().slice(11,19);
const LOG_FILE=new URL('./engine.log',import.meta.url);
const push=(m,cls='')=>{S.log.unshift({t:ts(),m,cls});S.log=S.log.slice(0,150);const line=`[${new Date().toISOString()}] ${m}`;console.log(line);try{fs.appendFileSync(LOG_FILE,line+'\n');}catch{}};

async function jfetch(url,opts={},tries=3){for(let i=0;i<tries;i++){try{const r=await fetch(url,{...opts,headers:{...jupHeaders,...(opts.headers||{})},signal:AbortSignal.timeout(12000)});if(r.status===429){S.stats.rateLimitHits++;await sleep(3000*(i+1));continue;}if(r.ok)return await r.json();}catch{}await sleep(600*(i+1));}return null;}

// ONE call gets all prices — 16x fewer requests than quoting each
async function fetchPrices(){
  const d=await jfetch(`https://api.jup.ag/price/v3?ids=${MINTS}`);
  if(!d)return null;
  const out={};
  for(const [mint,info] of Object.entries(d)){if(info?.usdPrice)out[BYMINT[mint]]=info.usdPrice;}
  return out;
}
async function poolsFor(mint){const d=await jfetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);return (d?.data||[]).map(p=>({name:p.attributes?.name?.slice(0,18)||'?',liq:Math.round(Number(p.attributes?.reserve_in_usd||0))})).filter(p=>p.liq>1000).sort((a,b)=>b.liq-a.liq).slice(0,3);}

// ---- CEX prices (Coinbase + Kraken, free public APIs) ----
const CEX_MAP={USDT:{cb:'USDT-USD',kr:'USDTUSD'},USDC:{cb:null,kr:'USDCUSD'},DAI:{cb:'DAI-USD',kr:'DAIUSD'},PYUSD:{cb:'PYUSD-USD',kr:null}};
async function fetchCEX(){
  const out={};
  for(const [sym,ids] of Object.entries(CEX_MAP)){
    let cb=null,kr=null;
    if(ids.cb){const d=await jfetch(`https://api.coinbase.com/v2/prices/${ids.cb}/spot`);cb=d?.data?.amount?Number(d.data.amount):null;}
    if(ids.kr){const d=await jfetch(`https://api.kraken.com/0/public/Ticker?pair=${ids.kr}`);const r=d?.result;const k=r?Object.keys(r)[0]:null;kr=k?Number(r[k].c[0]):null;}
    out[sym]={coinbase:cb,kraken:kr};
    await sleep(150);
  }
  return out;
}
// ---- CoinGecko 15-coin stablecoin feed (auto-discovers depegs beyond our list) ----
async function fetchGecko(){
  const d=await jfetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=15&page=1');
  if(!Array.isArray(d))return[];
  return d.filter(c=>{const p=c.current_price;return p&&Math.abs(p-1)<0.05;}) // exclude yield-tokens like USDY at 1.13
    .map(c=>({sym:c.symbol.toUpperCase(),price:c.current_price,dev:c.current_price-1,mcap:c.market_cap}));
}

const positions=new Map();
async function scan(){
  const prices=await fetchPrices();
  const out=[];
  for(const s of STABLES){
    let price=prices?.[s.sym];
    // POSITION SAFETY: if price fetch failed but we HOLD this coin, use last known — never go blind
    if(price==null && positions.has(s.sym)) price=S.lastPrices[s.sym];
    if(price==null){out.push({sym:s.sym,price:null,stale:positions.has(s.sym)});continue;}
    S.lastPrices[s.sym]=price;
    const dev=price-1;
    if(Math.abs(dev)>0.05){out.push({sym:s.sym,price,dev:null,bad:true});continue;}
    const cost=CFG.COST_EST;
    const edge=Math.abs(dev)-cost;
    const pos=positions.get(s.sym);
    // BUY cheap
    if(!pos && dev<0 && Math.abs(dev)>=CFG.DEPEG_BPS && edge>0 && positions.size<CFG.MAX_POSITIONS){
      const size=Math.min(S.portfolio.cash,S.portfolio.startCapital*CFG.POS_PCT);
      if(size>=10){
        positions.set(s.sym,{side:'long',entry:price,sizeUSD:size,cost,openedAt:Date.now()});
        S.portfolio.cash-=size;S.portfolio.deployed+=size;S.stats.signals++;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`BUY ${s.sym} @ ${price.toFixed(5)} | $${size.toFixed(2)} (${(CFG.POS_PCT*100)}%) | ${(dev*100).toFixed(3)}% cheap, edge +${(edge*100).toFixed(3)}% | target ${(1-CFG.SELL_BPS).toFixed(5)}`,'ok');
      }
    }
    // SHORT rich (paper-simulated; live needs inventory/borrow)
    if(!pos && CFG.SHORT && (BORROWABLE[s.sym]||false) && dev>0 && Math.abs(dev)>=CFG.DEPEG_BPS && edge>0 && positions.size<CFG.MAX_POSITIONS){
      const size=Math.min(S.portfolio.cash,S.portfolio.startCapital*CFG.POS_PCT);
      if(size>=10){
        const borrowable=BORROWABLE[s.sym]||false;
        positions.set(s.sym,{side:'short',entry:price,sizeUSD:size,cost,openedAt:Date.now(),borrowable});
        S.portfolio.cash-=size;S.portfolio.deployed+=size;S.stats.signals++;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`SHORT ${s.sym} @ ${price.toFixed(5)} | $${size.toFixed(2)} | ${(dev*100).toFixed(3)}% rich, edge +${(edge*100).toFixed(3)}% | ${borrowable?'EXECUTABLE (borrowable)':'SIM-ONLY (cannot borrow this coin)'}`,borrowable?'warn':'err');
      }
    }
    // COVER short at repeg (price fell back to peg)
    if(pos && pos.side==='short' && price<=(1+CFG.SELL_BPS)){
      const netPct=(pos.entry-price)-pos.cost;
      const pnl=netPct*pos.sizeUSD;const roi=netPct*100;
      S.portfolio.cash+=pos.sizeUSD+pnl;S.portfolio.deployed-=pos.sizeUSD;S.portfolio.realizedPnl+=pnl;
      S.stats.trades++;pnl>=0?S.stats.wins++:S.stats.losses++;
      const held=((Date.now()-pos.openedAt)/1000).toFixed(0);
      const trade={sym:s.sym,entry:pos.entry,exit:price,sizeUSD:pos.sizeUSD,pnl,roi,held,t:ts(),date:new Date().toISOString(),side:'short',executable:pos.borrowable||false};
      S.trades.unshift(trade);S.trades=S.trades.slice(0,40);
      ledger.trades.unshift(trade);ledger.realizedPnl=S.portfolio.realizedPnl;ledger.wins=S.stats.wins;ledger.losses=S.stats.losses;saveTrades(ledger);
      S.lastEvent={type:'SELL',sym:s.sym,pnl,at:Date.now()};
      push(`COVER ${s.sym} @ ${price.toFixed(5)} | entry ${pos.entry.toFixed(5)} | $${pos.sizeUSD.toFixed(2)} | held ${held}s | PROFIT ${pnl>=0?'+':''}$${pnl.toFixed(2)} | ROI ${roi>=0?'+':''}${roi.toFixed(3)}% [logged]`,pnl>=0?'ok':'err');
      positions.delete(s.sym);
    }
    // SELL long at repeg
    if(pos && pos.side==='long' && price>=(1-CFG.SELL_BPS)){
      const netPct=(price-pos.entry)-pos.cost;
      const pnl=netPct*pos.sizeUSD;const roi=netPct*100;
      S.portfolio.cash+=pos.sizeUSD+pnl;S.portfolio.deployed-=pos.sizeUSD;S.portfolio.realizedPnl+=pnl;
      S.stats.trades++;pnl>=0?S.stats.wins++:S.stats.losses++;
      const held=((Date.now()-pos.openedAt)/1000).toFixed(0);
      const trade={sym:s.sym,entry:pos.entry,exit:price,sizeUSD:pos.sizeUSD,pnl,roi,held,t:ts(),date:new Date().toISOString()};
      S.trades.unshift(trade);S.trades=S.trades.slice(0,40);
      // persist permanently
      ledger.trades.unshift(trade);ledger.realizedPnl=S.portfolio.realizedPnl;ledger.wins=S.stats.wins;ledger.losses=S.stats.losses;saveTrades(ledger);
      S.lastEvent={type:'SELL',sym:s.sym,pnl,at:Date.now()};
      push(`SELL ${s.sym} @ ${price.toFixed(5)} | entry ${pos.entry.toFixed(5)} | $${pos.sizeUSD.toFixed(2)} | held ${held}s | PROFIT ${pnl>=0?'+':''}$${pnl.toFixed(2)} | ROI ${roi>=0?'+':''}${roi.toFixed(3)}% [logged]`,pnl>=0?'ok':'err');
      positions.delete(s.sym);
    }
    const p=positions.get(s.sym);
    const cx=S.cex[s.sym]||{};
    const cexPrice=cx.coinbase||cx.kraken||null;
    const cexSpread=cexPrice?(price-cexPrice):null; // DEX price minus CEX price
    out.push({sym:s.sym,price,dev,cost,edge,alert:Math.abs(dev)>=CFG.DEPEG_BPS&&edge>0&&(dev<0||(CFG.SHORT&&dev>0)),rich:dev>0,
      cexPrice,cexSpread,cexVenue:cx.coinbase?'CB':cx.kraken?'KR':null,
      holding:!!p,entry:p?.entry,sizeUSD:p?.sizeUSD,unrealPnl:p?((p.side==='short'?(p.entry-price):(price-p.entry))*p.sizeUSD):null});
  }
  S.stables=out;
  S.portfolio.equity=S.portfolio.cash+S.portfolio.deployed;
  S.portfolio.roi=((S.portfolio.equity+S.portfolio.realizedPnl-S.portfolio.startCapital)/S.portfolio.startCapital)*100;
  S.positions=[...positions.entries()].map(([sym,p])=>{const cur=S.lastPrices[sym]||p.entry;const upnl=(p.side==='short'?(p.entry-cur):(cur-p.entry))*p.sizeUSD;return{sym,side:p.side,entry:p.entry,sizeUSD:p.sizeUSD,cur,target:p.side==='short'?1+CFG.SELL_BPS:1-CFG.SELL_BPS,age:Math.round((Date.now()-p.openedAt)/1000),unrealPnl:upnl};});
  // equity curve: total equity incl unrealized, sampled
  const unreal=S.positions.reduce((a,p)=>a+p.unrealPnl,0);
  const totalEquity=S.portfolio.cash+S.portfolio.deployed+S.portfolio.realizedPnl+unreal;
  S.equityHistory.push({t:Date.now(),eq:Number(totalEquity.toFixed(2))});
  if(S.equityHistory.length>500)S.equityHistory=S.equityHistory.slice(-500);
}
async function refreshPools(){S.poolMap=S.poolMap||{};for(const s of STABLES){S.poolMap[s.sym]=await poolsFor(s.mint);await sleep(400);}}

const DASH=fs.existsSync(new URL('./dashboard.html',import.meta.url))?fs.readFileSync(new URL('./dashboard.html',import.meta.url),'utf8'):'<h1>dashboard.html missing</h1>';
http.createServer((req,res)=>{
  if(req.url.startsWith('/state')){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(S));}
  else if(req.url.startsWith('/stats')){
    const summary={sinceInception:S.stats.sinceInception,totalTrades:S.stats.trades,wins:S.stats.wins,losses:S.stats.losses,winRate:S.stats.trades?(S.stats.wins/S.stats.trades*100).toFixed(1)+'%':'n/a',realizedPnl:'$'+S.portfolio.realizedPnl.toFixed(2),roi:S.portfolio.roi.toFixed(3)+'%',equity:'$'+(S.portfolio.equity+S.portfolio.realizedPnl).toFixed(2),openPositions:S.positions.length,rateLimitHits:S.stats.rateLimitHits,cyclesRun:S.cycle,recentTrades:S.trades.slice(0,10)};
    res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(summary,null,2));}
  else if(req.url.startsWith('/report')){
    const p=S.portfolio,st=S.stats;
    const wr=st.trades?(st.wins/st.trades*100).toFixed(1):'0';
    let md=`# DUMPSTR DEPEG DESK — SESSION REPORT\n\n`;
    md+=`Generated: ${new Date().toISOString()}\n`;
    md+=`Since inception: ${st.sinceInception}\n\n`;
    md+=`## PERFORMANCE\n`;
    md+=`- Portfolio equity: $${(p.equity+p.realizedPnl).toFixed(2)} (started $${p.startCapital})\n`;
    md+=`- Realized PnL: $${p.realizedPnl.toFixed(2)}\n`;
    md+=`- Total ROI: ${p.roi.toFixed(3)}%\n`;
    md+=`- Lifetime trades: ${st.trades} (${st.wins}W / ${st.losses}L, ${wr}% win rate)\n`;
    md+=`- Open positions: ${S.positions.length} ($${p.deployed.toFixed(2)} deployed)\n`;
    md+=`- Cycles run: ${S.cycle} | Rate-limit hits: ${st.rateLimitHits}\n\n`;
    md+=`## CURRENT BOARD\n`;
    for(const x of S.stables){if(x.price)md+=`- ${x.sym}: ${x.price.toFixed(5)} (${x.dev!=null?(x.dev*100).toFixed(3):'?'}% off peg)${x.holding?' [HOLDING]':''}${x.alert?' [SIGNAL]':''}\n`;}
    md+=`\n## OPEN POSITIONS\n`;
    for(const pos of S.positions)md+=`- ${pos.side.toUpperCase()} ${pos.sym}: $${pos.sizeUSD} @ ${pos.entry.toFixed(5)}, now ${pos.cur.toFixed(5)}, P&L $${pos.unrealPnl.toFixed(2)}, held ${pos.age}s\n`;
    if(!S.positions.length)md+=`(flat)\n`;
    md+=`\n## RECENT CLOSED TRADES\n`;
    for(const t of S.trades.slice(0,20))md+=`- ${t.date||t.t} ${t.side||'long'} ${t.sym}: entry ${t.entry.toFixed(5)} exit ${t.exit.toFixed(5)} size $${t.sizeUSD} PnL $${t.pnl.toFixed(2)} ROI ${t.roi.toFixed(3)}% held ${t.held}s\n`;
    if(!S.trades.length)md+=`(none yet)\n`;
    res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});res.end(md);}
  else{res.writeHead(200,{'Content-Type':'text/html'});res.end(DASH);}
}).listen(CFG.PORT,()=>push(`cockpit live -> http://localhost:${CFG.PORT} · stats at /stats`,'ok'));

push(`DUMPSTR DEPEG ENGINE v3 · PAPER · $${CFG.START_USD} · Jupiter ${S.jup} · ${STABLES.length} coins/call · buy@${(CFG.DEPEG_BPS*100).toFixed(2)}% sell@${(CFG.SELL_BPS*100).toFixed(2)}%`);
push(`lifetime: ${ledger.trades.length} trades · $${(ledger.realizedPnl||0).toFixed(2)} realized since ${ledger.sinceInception?.slice(0,10)}`,'ok');
await refreshPools();let lastPools=Date.now();
while(true){
  S.cycle++;
  await scan();
  if(S.cycle%6===1){try{S.cex=await fetchCEX();}catch{} try{S.gecko=await fetchGecko();}catch{}}
  push(`cycle ${S.cycle}: equity $${S.portfolio.equity.toFixed(2)} · realized $${S.portfolio.realizedPnl.toFixed(2)} · ROI ${S.portfolio.roi.toFixed(3)}% · ${S.positions.length} open · ${S.stats.trades} lifetime · 429s:${S.stats.rateLimitHits}`);
  if(Date.now()-lastPools>3*60000){await refreshPools();lastPools=Date.now();}
  await sleep(CFG.CYCLE_MS);
}
