
// DUMPSTR DEPEG ENGINE — $portfolio sim, position sizing, full trade log, cockpit server.
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import fs from 'node:fs';

function loadEnv(){try{const t=fs.readFileSync(new URL('./.env',import.meta.url),'utf8');for(const l of t.split('\n')){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);if(m)process.env[m[1]]=m[2];}}catch{}}
loadEnv();
const HELIUS_KEY=process.env.HELIUS_KEY||'';
const RPC=HELIUS_KEY?`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`:'https://solana-rpc.publicnode.com';
const CFG={
  PORT:Number(process.env.PORT||8787),
  START_USD:Number(process.env.CAPITAL||10000),
  POS_PCT:Number(process.env.POS_PCT||20)/100,
  MAX_POSITIONS:Number(process.env.MAX_POS||5),
  DEPEG_BPS:Number(process.env.DEPEG_BPS||15)/10000,
  SELL_BPS:Number(process.env.SELL_BPS||5)/10000,
};
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STABLES=[
  {sym:'USDT',mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'},
  {sym:'PYUSD',mint:'2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'},
  {sym:'USDS',mint:'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA'},
  {sym:'FDUSD',mint:'9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u'},
  {sym:'USDe',mint:'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT'},
  {sym:'sUSD',mint:'susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X'},
  {sym:'AUSD',mint:'AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9'},
  {sym:'USDG',mint:'2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'},
];
const DEC={USDT:6,PYUSD:6,USDS:6,FDUSD:6,USDe:6,sUSD:6,AUSD:6,USDG:6};

const S={
  mode:'PAPER',started:Date.now(),cycle:0,rpc:HELIUS_KEY?'HELIUS':'public',
  cfg:{capital:CFG.START_USD,posPct:CFG.POS_PCT,maxPos:CFG.MAX_POSITIONS,depeg:CFG.DEPEG_BPS,sell:CFG.SELL_BPS},
  portfolio:{cash:CFG.START_USD,deployed:0,equity:CFG.START_USD,realizedPnl:0,startCapital:CFG.START_USD,roi:0},
  stables:[],positions:[],poolMap:{},trades:[],log:[],
  stats:{signals:0,trades:0,wins:0,losses:0},lastEvent:null,
};
const ts=()=>new Date().toISOString().slice(11,19);
const push=(m,cls='')=>{S.log.unshift({t:ts(),m,cls});S.log=S.log.slice(0,150);console.log(`[${ts()}] ${m}`);};

async function jfetch(url,opts={},tries=3){for(let i=0;i<tries;i++){try{const r=await fetch(url,{...opts,signal:AbortSignal.timeout(12000)});if(r.status===429){await sleep(2500*(i+1));continue;}if(r.ok)return await r.json();}catch{}await sleep(600*(i+1));}return null;}
async function quote(inM,outM,amt){const u=new URL('https://lite-api.jup.ag/swap/v1/quote');u.search=new URLSearchParams({inputMint:inM,outputMint:outM,amount:String(amt),slippageBps:'100'});const j=await jfetch(u.toString(),{},2);return j?.outAmount?BigInt(j.outAmount):null;}
async function poolsFor(mint){const d=await jfetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`);return (d?.data||[]).map(p=>({name:p.attributes?.name?.slice(0,18)||'?',liq:Math.round(Number(p.attributes?.reserve_in_usd||0))})).filter(p=>p.liq>1000).sort((a,b)=>b.liq-a.liq).slice(0,3);}

const positions=new Map();
async function scan(){
  const out=[];const TEST=1000_000_000;
  for(const s of STABLES){
    const dec=DEC[s.sym]||6;
    const q1=await quote(USDC,s.mint,TEST);await sleep(250);
    if(!q1){out.push({sym:s.sym,price:null});continue;}
    const q2=await quote(s.mint,USDC,Number(q1));await sleep(250);
    const units=Number(q1)/(10**dec);const price=1000/units;const dev=price-1;
    if(!isFinite(price)||Math.abs(dev)>0.05){out.push({sym:s.sym,price:isFinite(price)?price:null,dev:null,bad:true});continue;}
    const roundNet=q2?(Number(q2)-TEST)/TEST:null;
    const cost=q2?Math.abs(Math.min(roundNet,0)):0.001;
    const edge=Math.abs(dev)-cost;
    const pos=positions.get(s.sym);
    if(!pos && dev<0 && Math.abs(dev)>=CFG.DEPEG_BPS && edge>0 && positions.size<CFG.MAX_POSITIONS){
      const size=Math.min(S.portfolio.cash, S.portfolio.startCapital*CFG.POS_PCT);
      if(size>=10){
        positions.set(s.sym,{side:'long',entry:price,sizeUSD:size,cost,openedAt:Date.now()});
        S.portfolio.cash-=size;S.portfolio.deployed+=size;S.stats.signals++;
        S.lastEvent={type:'BUY',sym:s.sym,at:Date.now()};
        push(`BUY ${s.sym} @ ${price.toFixed(5)} | deployed $${size.toFixed(2)} (${(CFG.POS_PCT*100)}% of capital) | trigger ${(dev*100).toFixed(3)}% cheap, cost ${(cost*100).toFixed(3)}%, edge +${(edge*100).toFixed(3)}% | checks dev<0 depeg>=${(CFG.DEPEG_BPS*100).toFixed(2)}% edge>0 slots ${positions.size}/${CFG.MAX_POSITIONS}`,'ok');
      }
    }
    if(pos && pos.side==='long' && price>=(1-CFG.SELL_BPS)){
      const netPct=(price-pos.entry)-pos.cost;
      const pnl=netPct*pos.sizeUSD;const roi=netPct*100;
      S.portfolio.cash+=pos.sizeUSD+pnl;S.portfolio.deployed-=pos.sizeUSD;S.portfolio.realizedPnl+=pnl;
      S.stats.trades++;pnl>=0?S.stats.wins++:S.stats.losses++;
      const held=((Date.now()-pos.openedAt)/1000).toFixed(0);
      S.trades.unshift({sym:s.sym,entry:pos.entry,exit:price,sizeUSD:pos.sizeUSD,pnl,roi,held,t:ts()});
      S.trades=S.trades.slice(0,40);
      S.lastEvent={type:'SELL',sym:s.sym,pnl,at:Date.now()};
      push(`SELL ${s.sym} @ ${price.toFixed(5)} | entry ${pos.entry.toFixed(5)} | size $${pos.sizeUSD.toFixed(2)} | held ${held}s | PROFIT ${pnl>=0?'+':''}$${pnl.toFixed(2)} | ROI ${roi>=0?'+':''}${roi.toFixed(3)}%`,pnl>=0?'ok':'err');
      positions.delete(s.sym);
    }
    const p=positions.get(s.sym);
    out.push({sym:s.sym,price,dev,cost,edge,alert:Math.abs(dev)>=CFG.DEPEG_BPS&&edge>0&&dev<0,rich:dev>0,
      holding:!!p,entry:p?.entry,sizeUSD:p?.sizeUSD,unrealPnl:p?(price-p.entry)*p.sizeUSD:null});
  }
  S.stables=out;
  S.portfolio.equity=S.portfolio.cash+S.portfolio.deployed;
  S.portfolio.roi=((S.portfolio.equity+S.portfolio.realizedPnl-S.portfolio.startCapital)/S.portfolio.startCapital)*100;
  S.positions=[...positions.entries()].map(([sym,p])=>({sym,side:p.side,entry:p.entry,sizeUSD:p.sizeUSD,age:Math.round((Date.now()-p.openedAt)/1000)}));
}
async function refreshPools(){S.poolMap=S.poolMap||{};for(const s of STABLES){S.poolMap[s.sym]=await poolsFor(s.mint);await sleep(400);}}

const DASH=fs.existsSync(new URL('./dashboard.html',import.meta.url))?fs.readFileSync(new URL('./dashboard.html',import.meta.url),'utf8'):'<h1>dashboard.html missing</h1>';
http.createServer((req,res)=>{
  if(req.url.startsWith('/state')){res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(S));}
  else{res.writeHead(200,{'Content-Type':'text/html'});res.end(DASH);}
}).listen(CFG.PORT,()=>push(`cockpit live -> http://localhost:${CFG.PORT}`,'ok'));

push(`DUMPSTR DEPEG ENGINE · PAPER · $${CFG.START_USD} capital · ${(CFG.POS_PCT*100)}% per trade · max ${CFG.MAX_POSITIONS} positions`);
await refreshPools();let lastPools=Date.now();
while(true){
  S.cycle++;
  await scan();
  push(`cycle ${S.cycle}: equity $${S.portfolio.equity.toFixed(2)} · realized $${S.portfolio.realizedPnl.toFixed(2)} · ROI ${S.portfolio.roi.toFixed(3)}% · ${S.positions.length} open · ${S.stats.trades} closed`);
  if(Date.now()-lastPools>3*60000){await refreshPools();lastPools=Date.now();}
  await sleep(3000);
}
