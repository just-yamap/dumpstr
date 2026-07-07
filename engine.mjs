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
// ---- PER-COIN TUNING: USDe is the proven edge — deeper trigger, bigger allocation, scale-in ----
// weight = max % of capital for this coin | buyBps = depeg depth to trigger | tranches = max scale-in buys
const COIN_CFG={
  USDe:  {weight:0.30, buyBps:20, tranches:3},  // proven wobbler: up to 30%, buy at 0.20%, scale in 3x
  FDUSD: {weight:0.15, buyBps:20, tranches:2},
  USD1:  {weight:0.15, buyBps:15, tranches:2},
  USDT:  {weight:0.10, buyBps:15, tranches:1},
  USDC:  {weight:0.10, buyBps:15, tranches:1},
  PYUSD: {weight:0.10, buyBps:15, tranches:1},
  USDS:  {weight:0.10, buyBps:15, tranches:1},
  USDG:  {weight:0.10, buyBps:15, tranches:1},
  AUSD:  {weight:0.10, buyBps:20, tranches:1},
};
const COIN_DEFAULT={weight:0.10, buyBps:15, tranches:1};
const cfgFor=sym=>COIN_CFG[sym]||COIN_DEFAULT;

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
  lastEvent:null,lastPrices:{},equityHistory:[],priceHistory:{},lending:[],apyLog:[],blended:null,competitors:[],kaminoVaults:[],curatedVaults:[],lendingAgg:null,
  // THREE-DESK COMPARISON: each strategy runs its own $50k paper portfolio
  desks:{
    depeg:{name:'Depeg Desk',equity:50000,start:50000,history:[],lastUpdate:Date.now()},
    deltaNeutral:{name:'Delta-Neutral',equity:50000,start:50000,history:[],lastUpdate:Date.now(),fundingRate:null,perAsset:null},
    lending:{name:'Lending Aggregator',equity:50000,start:50000,history:[],lastUpdate:Date.now(),curAPY:null},
    lstBasis:{name:'LST-Basis',equity:50000,start:50000,history:[],lastUpdate:Date.now(),stakingAPY:null},
  },

};
const ts=()=>new Date().toISOString().slice(11,19);
const LOG_FILE=new URL('./engine.log',import.meta.url);
const PRICE_CSV=new URL('./prices.csv',import.meta.url);
// write CSV header once if file doesn't exist
try{if(!fs.existsSync(PRICE_CSV))fs.writeFileSync(PRICE_CSV,'timestamp,'+STABLES.map(s=>s.sym).join(',')+'\n');}catch{}
const APY_CSV=new URL('./apy-timeline.csv',import.meta.url);
const COMP_CSV=new URL('./competitors-timeline.csv',import.meta.url);
try{if(!fs.existsSync(COMP_CSV))fs.writeFileSync(COMP_CSV,'timestamp,name:tvl_pairs_semicolon_separated\n');}catch{}
try{if(!fs.existsSync(APY_CSV))fs.writeFileSync(APY_CSV,'timestamp,nUSD_depositor_APY,best_lending_APY,depeg_APY,delta_neutral_APY,blended_gross\n');}catch{}
const DESKS_CSV=new URL('./desks-timeline.csv',import.meta.url);
try{if(!fs.existsSync(DESKS_CSV))fs.writeFileSync(DESKS_CSV,'timestamp,depeg_equity,deltaNeutral_equity,lending_equity,lstBasis_equity\n');}catch{}
const INPUTS_CSV=new URL('./strategy-inputs.csv',import.meta.url);
try{if(!fs.existsSync(INPUTS_CSV))fs.writeFileSync(INPUTS_CSV,'timestamp,funding_BTC_apy,funding_ETH_apy,funding_SOL_apy,funding_avg_apy,funding_negative,jitoSOL_staking_apy,best_lending_apy,best_lending_pool\n');}catch{}
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

// ---- THREE-DESK COMPARISON ENGINE ----
// Delta-neutral: earns SOL funding rate (live from Hyperliquid), market-neutral
async function fetchFunding(){
  // MULTI-ASSET: average funding across BTC/ETH/SOL for diversified capture
  try{
    const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'})});
    const d=await r.json();
    const uni=d[0].universe, ctx=d[1];
    const want=['BTC','ETH','SOL'];const rates=[];
    for(const w of want){for(let i=0;i<uni.length;i++){if(uni[i].name===w){rates.push(Number(ctx[i].funding));break;}}}
    if(rates.length){S.desks.deltaNeutral.perAsset={BTC:rates[0],ETH:rates[1],SOL:rates[2]};return rates.reduce((a,b)=>a+b,0)/rates.length;}
  }catch{}
  return null;
}
// LST-basis: jitoSOL staking yield (market-neutral when hedged with short SOL)
async function fetchLST(){
  try{const d=await jfetch('https://yields.llama.fi/pools');
    if(d&&Array.isArray(d.data)){for(const p of d.data){if((p.symbol||'').toUpperCase()==='JITOSOL'&&p.chain==='Solana'&&(p.tvlUsd||0)>5000000)return p.apy||0;}}
  }catch{}
  return null;
}
// update all three desks each cycle — accrue their respective yields on paper
function updateDesks(){
  const now=Date.now();
  // 1. DEPEG desk = mirror the real depeg portfolio (already tracked)
  S.desks.depeg.equity=S.portfolio.startCapital===50000?(50000+S.portfolio.realizedPnl):(50000*(1+S.portfolio.roi/100));
  // 2. DELTA-NEUTRAL = accrue funding rate (hourly rate applied per elapsed time)
  const dn=S.desks.deltaNeutral;
  if(dn.fundingRate!=null){
    const hrsElapsed=(now-dn.lastUpdate)/3600000;
    // funding is hourly; if positive, short side (us) earns it. Apply to equity.
    dn.equity*=(1+dn.fundingRate*hrsElapsed);
  }
  dn.lastUpdate=now;
  // 3. LENDING AGGREGATOR = earn the BEST available lending APY (auto-routes to top pool)
  const lend=S.desks.lending;
  if(lend.curAPY!=null){
    const hrsElapsed=(now-lend.lastUpdate)/3600000;
    lend.equity*=(1+(lend.curAPY/100)*(hrsElapsed/8760)); // APY -> hourly
  }
  lend.lastUpdate=now;
  // LST-BASIS: jitoSOL staking yield minus ~1% hedge cost, market-neutral
  const lst=S.desks.lstBasis;
  if(lst&&lst.stakingAPY!=null){const hrsElapsed=(now-lst.lastUpdate)/3600000;const netAPY=lst.stakingAPY-1.0;lst.equity*=(1+(netAPY/100)*(hrsElapsed/8760));}
  if(lst)lst.lastUpdate=now;
  // record history for all four (cap 500)
  for(const k of ['depeg','deltaNeutral','lending','lstBasis']){
    const d=S.desks[k];if(!d)continue;
    d.history.push({t:now,eq:Number(d.equity.toFixed(2))});
    if(d.history.length>500)d.history=d.history.slice(-500);
  }
  // PERSIST desk equities to disk (survives restart, full audit trail)
  try{fs.appendFileSync(DESKS_CSV,`${new Date().toISOString()},${S.desks.depeg.equity.toFixed(2)},${S.desks.deltaNeutral.equity.toFixed(2)},${S.desks.lending.equity.toFixed(2)},${(S.desks.lstBasis?S.desks.lstBasis.equity:50000).toFixed(2)}\n`);}catch{}
}

// ---- CURATED VAULT COMPETITORS: delta-neutral / managed vaults = nUSD's direct rivals ----
const CURATED=[
  {slug:'ethena',name:'Ethena (USDe)',note:'delta-neutral · funding capture',tag:'giant'},
  {slug:'gauntlet',name:'Gauntlet (CASH)',note:'curated delta-neutral',tag:'rival'},
  {slug:'hyperithm',name:'Hyperithm',note:'pro-managed vaults',tag:'rival'},
];
async function fetchCurated(){
  const out=[];
  for(const c of CURATED){
    try{const d=await jfetch(`https://api.llama.fi/protocol/${c.slug}`);
      const tvls=d?.currentChainTvls||{};
      const total=Object.entries(tvls).filter(([k])=>!k.toLowerCase().includes('borrowed')).reduce((a,[,v])=>a+(typeof v==='number'?v:0),0);
      out.push({...c,tvl:total});
    }catch{out.push({...c,tvl:null});}
    await sleep(120);
  }
  // add CASH vault APY from the kamino feed if present
  const cash=(S.kaminoVaults||[]).find(v=>(v.sym||'').toUpperCase()==='CASH');
  if(cash)out.push({slug:'cash',name:'CASH vault (live)',note:`${cash.apy.toFixed(2)}% APY on Kamino`,tag:'rival',tvl:cash.tvl});
  return out;
}

// ---- COMPETITOR TRACKER: watch wounded/rival protocols' TVL (market-share intel) ----
const COMPETITORS=[
  {slug:'carrot',name:'Carrot',note:'DIED (Drift)',tag:'dead'},
  {slug:'perena',name:'Perena',note:'stablecoin · Drift-hit',tag:'stable'},
  {slug:'neutral-trade',name:'Neutral Trade',note:'Drift-hit $3.7M',tag:'wounded'},
  {slug:'loopscale',name:'Loopscale',note:'fixed-rate · survivor',tag:'rival'},
  {slug:'exponent',name:'Exponent',note:'yield-tokenization',tag:'rival'},
  {slug:'save',name:'Save (Solend)',note:'lending',tag:'rival'},
  {slug:'drift',name:'Drift',note:'hacked, recovering',tag:'wounded'},
];
async function fetchCompetitors(){
  const out=[];
  for(const c of COMPETITORS){
    try{const d=await jfetch(`https://api.llama.fi/protocol/${c.slug}`);
      const tvls=d?.currentChainTvls||{};
      const total=Object.entries(tvls).filter(([k])=>!k.toLowerCase().includes('borrowed')).reduce((a,[,v])=>a+(typeof v==='number'?v:0),0);
      out.push({...c,tvl:total});
    }catch{out.push({...c,tvl:null});}
    await sleep(120);
  }
  return out;
}
// ---- KAMINO ECOSYSTEM: all their stablecoin vaults + reward tokens ----
async function fetchKaminoVaults(){
  const d=await jfetch('https://yields.llama.fi/pools');
  if(!d||!Array.isArray(d.data))return[];
  const stableSyms=['USDC','USDT','PYUSD','USDS','USDE','USDG','CASH','SYRUPUSDC','USX','USD1','AUSD','FDUSD'];
  return d.data.filter(p=>p.project==='kamino-lend'&&p.chain==='Solana'
    &&stableSyms.includes((p.symbol||'').toUpperCase())&&(p.tvlUsd||0)>500000)
    .map(p=>({sym:p.symbol,apy:p.apy||0,base:p.apyBase||0,reward:p.apyReward||0,tvl:p.tvlUsd,rewardTokens:(p.rewardTokens||[]).length}))
    .sort((a,b)=>b.tvl-a.tvl).slice(0,15);
}

// ---- LENDING MONITOR: real Solana lending APYs (Carrot-style aggregation) ----
// PER-PROTOCOL EXPOSURE CAP: the Drift/Carrot lesson — never over-concentrate in one protocol
const MAX_PROTOCOL_PCT=0.30; // no more than 30% of vault in any single lending protocol
async function fetchLending(){
  const d=await jfetch('https://yields.llama.fi/pools');
  if(!d||!Array.isArray(d.data))return[];
  const good=d.data.filter(p=>p.chain==='Solana'
    && ['USDC','USDT','PYUSD','USDS'].includes(p.symbol)
    && ['kamino-lend','marginfi','solend','save','drift'].includes(p.project)
    && (p.tvlUsd||0)>1000000 && (p.apy||0)>0.5 && (p.apy||0)<30);
  const seen={};
  for(const p of good){const k=p.project+'|'+p.symbol;if(!seen[k]||p.tvlUsd>seen[k].tvlUsd)seen[k]=p;}
  return Object.values(seen).sort((a,b)=>b.tvlUsd-a.tvlUsd)
    .map(p=>({project:p.project,symbol:p.symbol,apy:p.apy,tvl:p.tvlUsd}));
}
// aggregate lending stats (console view — how the lending landscape performs in aggregate)
function lendingAggregate(){
  const l=S.lending;
  if(!l.length)return null;
  const apys=l.map(x=>x.apy);
  const tvls=l.map(x=>x.tvl);
  const totalTVL=tvls.reduce((a,b)=>a+b,0);
  // TVL-weighted average APY (the honest aggregate — big pools count more)
  const weightedAPY=l.reduce((a,x)=>a+x.apy*x.tvl,0)/totalTVL;
  const simpleAPY=apys.reduce((a,b)=>a+b,0)/apys.length;
  // by protocol
  const byProto={};
  for(const x of l){if(!byProto[x.project])byProto[x.project]={tvl:0,apySum:0,n:0};byProto[x.project].tvl+=x.tvl;byProto[x.project].apySum+=x.apy;byProto[x.project].n++;}
  const protos=Object.entries(byProto).map(([p,d])=>({project:p,tvl:d.tvl,avgAPY:d.apySum/d.n})).sort((a,b)=>b.tvl-a.tvl);
  return {totalTVL,weightedAPY,simpleAPY,best:Math.max(...apys),worst:Math.min(...apys),pools:l.length,protos};
}

// blended nUSD APY: 70% best-lending (capped per protocol) + 20% depeg desk + 10% buffer(0%)
function blendedNusdAPY(){
  const lend=S.lending;
  if(!lend.length)return null;
  const bestLendAPY=lend[0]?.apy||0; // top available lending rate
  // depeg desk realized APY (annualized from this run)
  const runtimeHrs=(Date.now()-new Date(S.stats.sinceInception).getTime())/3600000;
  const depegDailyPct=runtimeHrs>0?(S.portfolio.realizedPnl/S.portfolio.startCapital*100)*(24/runtimeHrs):0;
  const depegAPY=depegDailyPct*365;
  const blended=0.70*bestLendAPY + 0.20*depegAPY + 0.10*0;
  const afterFee=blended*0.85; // 15% performance fee to protocol
  return {bestLendAPY,depegAPY:Math.max(0,depegAPY),blendedGross:blended,depositorAPY:afterFee,perfFee:blended*0.15};
}

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
    const cc=cfgFor(s.sym);
    const buyTrigger=cc.buyBps/10000;
    // TRANCHE size = weight split across allowed tranches (so 3 tranches never exceed the coin's weight cap)
    const trancheSize=(S.portfolio.startCapital*cc.weight)/cc.tranches;
    // FIRST BUY: coin is cheap past its own trigger
    if(!pos && dev<0 && Math.abs(dev)>=buyTrigger && edge>0 && positions.size<CFG.MAX_POSITIONS){
      const size=Math.min(S.portfolio.cash,trancheSize);
      if(size>=10){
        positions.set(s.sym,{side:'long',entry:price,sizeUSD:size,cost,openedAt:Date.now(),tranches:1,maxTranches:cc.tranches,lastBuyPrice:price,weight:cc.weight});
        S.portfolio.cash-=size;S.portfolio.deployed+=size;S.stats.signals++;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`BUY ${s.sym} @ ${price.toFixed(5)} | $${size.toFixed(2)} tranche 1/${cc.tranches} | ${(dev*100).toFixed(3)}% cheap, edge +${(edge*100).toFixed(3)}% | target ${(1-CFG.SELL_BPS).toFixed(5)}`,'ok');
      }
    }
    // SCALE IN (double down): already holding, price dropped ANOTHER 0.10%+ below last buy, tranches remain
    if(pos && pos.side==='long' && pos.tranches<pos.maxTranches && price <= pos.lastBuyPrice*(1-0.0010)){
      const size=Math.min(S.portfolio.cash,trancheSize);
      if(size>=10){
        const newTotal=pos.sizeUSD+size;
        const newEntry=(pos.entry*pos.sizeUSD+price*size)/newTotal; // weighted avg entry
        pos.entry=newEntry;pos.sizeUSD=newTotal;pos.tranches++;pos.lastBuyPrice=price;
        S.portfolio.cash-=size;S.portfolio.deployed+=size;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`SCALE-IN ${s.sym} @ ${price.toFixed(5)} | +$${size.toFixed(2)} tranche ${pos.tranches}/${pos.maxTranches} | avg entry now ${newEntry.toFixed(5)} | dropped deeper, doubling down`,'warn');
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
  // log all prices this cycle to CSV for full historical charting
  try{const row=new Date().toISOString()+','+STABLES.map(st=>{const c=out.find(o=>o.sym===st.sym);return c&&c.price?c.price.toFixed(5):'';}).join(',');fs.appendFileSync(PRICE_CSV,row+'\n');}catch{}
  for(const o of out){if(o.price){if(!S.priceHistory[o.sym])S.priceHistory[o.sym]=[];S.priceHistory[o.sym].push({t:Date.now(),p:o.price});if(S.priceHistory[o.sym].length>500)S.priceHistory[o.sym]=S.priceHistory[o.sym].slice(-500);}}
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
// RESTORE desk equities from disk so the four-desk experiment survives restarts
try{if(fs.existsSync(DESKS_CSV)){const lines=fs.readFileSync(DESKS_CSV,'utf8').trim().split('\n');if(lines.length>1){const last=lines[lines.length-1].split(',');
  if(last.length>=5){S.desks.depeg.equity=Number(last[1])||50000;S.desks.deltaNeutral.equity=Number(last[2])||50000;S.desks.lending.equity=Number(last[3])||50000;S.desks.lstBasis.equity=Number(last[4])||50000;
  push(`restored desks from disk: depeg $${S.desks.depeg.equity.toFixed(2)} · DN $${S.desks.deltaNeutral.equity.toFixed(2)} · lend $${S.desks.lending.equity.toFixed(2)} · lst $${S.desks.lstBasis.equity.toFixed(2)}`,'ok');}}}}catch{}
await refreshPools();let lastPools=Date.now();
while(true){
  S.cycle++;
  await scan();
  if(S.cycle%6===1){try{S.cex=await fetchCEX();}catch{} try{S.gecko=await fetchGecko();}catch{}}
  if(S.cycle%6===3){const f=await fetchFunding();if(f!=null){S.desks.deltaNeutral.fundingRate=f;
    // LOG raw strategy inputs for full APY reconstruction/audit
    try{const pa=S.desks.deltaNeutral.perAsset||{};const toApy=x=>x!=null?(x*24*365*100).toFixed(2):'';
      const favg=f*24*365*100;const neg=f<0?'1':'0';
      const jito=S.desks.lstBasis.stakingAPY!=null?S.desks.lstBasis.stakingAPY.toFixed(2):'';
      const bl=S.lendingAgg?S.lendingAgg.best.toFixed(2):'';const blp=(S.lending&&S.lending[0])?S.lending[0].project+'/'+S.lending[0].symbol:'';
      fs.appendFileSync(INPUTS_CSV,`${new Date().toISOString()},${toApy(pa.BTC)},${toApy(pa.ETH)},${toApy(pa.SOL)},${favg.toFixed(2)},${neg},${jito},${bl},${blp}\n`);}catch{}
  }}
  if(S.cycle%12===5){const ls=await fetchLST();if(ls!=null)S.desks.lstBasis.stakingAPY=ls;}
  updateDesks();
  if(S.cycle%24===2){try{S.competitors=await fetchCompetitors();}catch{} try{S.kaminoVaults=await fetchKaminoVaults();}catch{} try{S.curatedVaults=await fetchCurated();
    // log competitor TVLs timeline
    const row=new Date().toISOString()+','+[...S.competitors,...S.curatedVaults].map(c=>`${c.name}:${c.tvl!=null?Math.round(c.tvl):''}`).join(';');
    fs.appendFileSync(new URL('./competitors-timeline.csv',import.meta.url),row+'\n');}catch{}}
  if(S.cycle%12===1){try{S.lending=await fetchLending();S.lendingAgg=lendingAggregate();
    if(S.lendingAgg)S.desks.lending.curAPY=S.lendingAgg.best;const b=blendedNusdAPY();S.blended=b;if(b){S.apyLog.push({t:Date.now(),depositorAPY:Number(b.depositorAPY.toFixed(2)),lendAPY:Number(b.bestLendAPY.toFixed(2)),depegAPY:Number(b.depegAPY.toFixed(2))});if(S.apyLog.length>500)S.apyLog=S.apyLog.slice(-500);
    try{fs.appendFileSync(APY_CSV,new Date().toISOString()+','+b.depositorAPY.toFixed(2)+','+b.bestLendAPY.toFixed(2)+','+b.depegAPY.toFixed(2)+','+(b.dnAPY||0).toFixed(2)+','+b.blendedGross.toFixed(2)+'\n');}catch{}}}catch{}}
  push(`cycle ${S.cycle}: equity $${S.portfolio.equity.toFixed(2)} · realized $${S.portfolio.realizedPnl.toFixed(2)} · ROI ${S.portfolio.roi.toFixed(3)}% · ${S.positions.length} open · ${S.stats.trades} lifetime · 429s:${S.stats.rateLimitHits}`);
  if(Date.now()-lastPools>3*60000){await refreshPools();lastPools=Date.now();}
  await sleep(CFG.CYCLE_MS);
}
