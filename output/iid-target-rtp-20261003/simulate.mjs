import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {drawActionableCard,cardFromId,resolveServerGuess,
 HIGH_LOW_FATE_SHIFT_DENOMINATOR} from '../../activity/server/highLowRules.mjs';

// HYPOTHETICAL behavior study, not a fitted/validated psychological model.
// Actual server rules drive ordinary bankroll sessions. For each actual wager,
// an independent Q trajectory estimates conditional expected return at exactly
// that session state. dQ/dP=F (fair multiplier) makes E_P[payout/wager]=E_Q[R_s].
// This second trajectory does NOT update the bankroll or emotional state.
// Thus loss-chasing, changing stakes, targets, and quitting remain under P.
const smoke=process.env.SIM_SMOKE==='1';
const correction=Number(process.env.SIM_CORRECTION || 1);
const baseN=smoke?20:1000,sensitivityN=smoke?10:500;
const out=new URL(process.env.SIM_OUTPUT || (smoke?'./smoke/':'./'),import.meta.url);
const R=[1,.995,1.005,1.015,1.025,1.035],fate=1/HIGH_LOW_FATE_SHIFT_DENOMINATOR;
const seeds=[842101,842107,842111];
const wagers=[100,1000,10000];
const profiles=[
 {id:'protect',label:'利益保全型',intercept:-1.5,streak:.8,danger:1.4,profit:.9,wealth:1.1,protect:1.2,chase:0,goal:1.4,upside:.2,hot:0,
  riskRate:0,maxHands:80,goalUnits:3,lossFraction:.25,lossUnits:10},
 {id:'balanced',label:'バランス型',intercept:-3.8,streak:1.0,danger:1.4,profit:.7,wealth:.8,protect:.6,chase:.25,goal:1.3,upside:.4,hot:.2,
  riskRate:.03,maxHands:250,goalUnits:15,lossFraction:.5,lossUnits:35},
 {id:'target',label:'目標利益型',intercept:-4.3,streak:.9,danger:1.2,profit:.65,wealth:.7,protect:.3,chase:.4,goal:3,upside:.5,hot:.15,
  riskRate:.02,maxHands:250,goalUnits:8,lossFraction:.5,lossUnits:35},
 {id:'chase',label:'損失回復型',intercept:-3.8,streak:.85,danger:.9,profit:.55,wealth:.35,protect:.25,chase:1.3,goal:1.5,upside:.6,hot:.25,
  riskRate:.04,maxHands:400,goalUnits:10,lossFraction:.85,lossUnits:Infinity,raiseAfterLosses:true},
 {id:'thrill',label:'高配当志向型',intercept:-4.8,streak:.7,danger:.4,profit:.5,wealth:.25,protect:0,chase:.2,goal:.8,upside:1.0,hot:.5,
  riskRate:.25,maxHands:300,goalUnits:50,lossFraction:.65,lossUnits:Infinity},
 {id:'ev',label:'期待値重視型',alwaysContinue:true,riskRate:0,maxHands:300,goalUnits:Infinity,lossFraction:1,lossUnits:Infinity},
];
const compositions=[
 {id:'equal',label:'6タイプを同人数ずつ',shares:{protect:1/6,balanced:1/6,target:1/6,chase:1/6,thrill:1/6,ev:1/6}},
 {id:'cautious',label:'慎重な人が多い構成',shares:{protect:.4,balanced:.25,target:.15,chase:.1,thrill:.05,ev:.05}},
 {id:'engaged',label:'中間・目標型が多い構成',shares:{protect:.15,balanced:.3,target:.2,chase:.15,thrill:.1,ev:.1}},
 {id:'aggressive',label:'粘る人・期待値重視が多い構成',shares:{protect:.05,balanced:.1,target:.1,chase:.25,thrill:.2,ev:.3}},
];
function randomSource(seed){let state=seed>>>0;return n=>{const limit=Math.floor(4294967296/n)*n;let x;do{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);x=(t^(t>>>14))>>>0;}while(x>=limit);return x%n;};}
const rand=rng=>rng(1_000_000)/1_000_000;
const clip=(x,a,b)=>Math.max(a,Math.min(b,x));
const logit=x=>1/(1+Math.exp(-clip(x,-30,30)));
function draw(counts,rng,predicate=()=>true){let n=0;for(let r=2;r<=14;r++)if(predicate(r))n+=counts[r];assert.ok(n>0);let k=rng(n);for(let r=2;r<=14;r++){if(!predicate(r))continue;if(k<counts[r]){return r;}k-=counts[r];}throw Error('draw');}
function actionable(counts,rng){let r;do{r=draw(counts,rng);}while(r===2||r===14);return r;}
function probabilities(counts,rank){let hi=0,lo=0;for(let r=2;r<rank;r++)lo+=counts[r];for(let r=rank+1;r<=14;r++)hi+=counts[r];assert.ok(hi+lo>0);return {hi,lo,higher:(hi+(hi>0?lo*fate:0))/(hi+lo),lower:(lo+(lo>0?hi*fate:0))/(hi+lo)};}
function direction(profile,ctx,p,rng){const safe=p.higher>=p.lower?'higher':'lower';const risky=safe==='higher'?'lower':'higher';let risk=profile.riskRate;
 if(profile.id==='thrill')risk+=.10*Math.min(ctx.winRun,3)/3;
 const g=rand(rng)<risk?risky:safe;return p[g]>0?g:safe;}
function decide(profile,ctx,{streak,F,rank,p,guess},rng){
 if(streak===5)return true;
 if(streak>0 && ctx.wallet-ctx.wager+Math.floor(ctx.wager*F/p[guess]*R[streak+1]*correction)>2147483647)return true;
 if(streak===0||profile.alwaysContinue)return false;
 const payout=ctx.wager*F*R[streak]*correction;
 const nextPayout=ctx.wager*F/p[guess]*R[streak+1]*correction;
 const walletIfCash=ctx.wallet-ctx.wager+payout;
 const sessionIfCash=walletIfCash-ctx.initial;
 const danger=clip((.85-p[guess])/.35,0,2);
 const gains=clip(Math.max(sessionIfCash,0)/(5*ctx.base),0,2);
 const deficit=clip(Math.max(-ctx.net,0)/(5*ctx.base),0,3);
 const exposed=payout/Math.max(walletIfCash,1);
 const goalReached=sessionIfCash>=profile.goalUnits*ctx.base;
 const recovers=ctx.net<0&&sessionIfCash>=0;
 let z=profile.intercept+ctx.personality+ctx.cashShift+profile.streak*(streak-1)
  +profile.danger*danger+profile.profit*Math.log(Math.max(payout/ctx.wager,1e-12))
  +profile.wealth*exposed+profile.protect*gains-profile.chase*deficit
  +profile.goal*(goalReached?1:0)+(profile.id==='chase'&&recovers?2.5:0)
  -profile.upside*Math.log(nextPayout/payout)-profile.hot*Math.min(ctx.winRun,3);
 if(profile.id==='target'&&payout<ctx.wager*2)z-=.75;
 return rand(rng)<logit(z);
}

function play(profile,ctx,rng,weighted=false,validate=false){
 const counts=Array(15).fill(4);counts[0]=counts[1]=0;
 let current,rank;
 if(weighted){rank=actionable(counts,rng);}
 else{current=drawActionableCard(rng).cardId;rank=cardFromId(current).value;}
 let streak=0,F=1,mayDecide=true,selected=null,turns=0,risky=0;
 for(;;){
  const p=probabilities(counts,rank);
  if(mayDecide){selected=direction(profile,ctx,p,rng);if(decide(profile,ctx,{streak,F,rank,p,guess:selected},rng))break;}
  turns++;if(p[selected]<Math.max(p.higher,p.lower))risky++;
  if(weighted){
   const n=p.hi+p.lo+counts[rank];
   if(rng(n)<counts[rank]){mayDecide=false;continue;}
   const next=draw(counts,rng,r=>selected==='higher'?r>rank:r<rank);
   F/=p[selected];streak++;rank=next===2||next===14?actionable(counts,rng):next;mayDecide=true;
  }else{
   const step=resolveServerGuess({currentCardId:current,guess:selected,randomIndex:rng});
   if(step.result==='loss')return {payout:0,F:0,streak:0,turns,risky,settledStreak:null};
   if(step.result==='win'){F/=p[selected];streak++;mayDecide=true;}else mayDecide=false;
   current=step.currentAfterCardId;rank=cardFromId(current).value;
  }
  if(streak===5)break;
 }
 const unrounded=ctx.wager*F*R[streak]*correction;
 const payout=Math.floor(unrounded);
 return {payout,F,streak,turns,risky,settledStreak:streak,
  expectedFactor:weighted?payout/(ctx.wager*F):undefined,
  unroundedFactor:weighted?R[streak]*correction:undefined};
}

function accumulator(){return {sessions:0,hands:0,wagers:0,expected:0,unrounded:0,paid:0,cv:0,
 w2:0,e2:0,ew:0,p2:0,pw:0,c2:0,cw:0,goalStops:0,lossStops:0,broke:0,
 positiveSessions:0,net:0,initial:0,turns:0,risky:0,maxPayout:0,
 terminalStreaks:Array(6).fill(0),betTiers:{100:0,1000:0,10000:0}};}
function ratioSummary(a,name,second,cross){const rate=a[name]/a.wagers;const residual=Math.max(0,a[second]-2*rate*a[cross]+rate*rate*a.w2);const se=Math.sqrt(a.sessions/(a.sessions-1)*residual)/a.wagers;return {rtp:100*rate,ci95HalfWidth:196*se};}
function summary(a){return {sessions:a.sessions,hands:a.hands,wagers:a.wagers,
 expected:ratioSummary(a,'expected','e2','ew'),raw:ratioSummary(a,'paid','p2','pw'),control:ratioSummary(a,'cv','c2','cw'),
 unroundedRtp:100*a.unrounded/a.wagers,averageHands:a.hands/a.sessions,averageWager:a.wagers/a.hands,
 averageTurnover:a.wagers/a.sessions,positiveSessionRate:a.positiveSessions/a.sessions,
 brokeRate:a.broke/a.sessions,goalStopRate:a.goalStops/a.sessions,lossStopRate:a.lossStops/a.sessions,
 riskyGuessRate:a.risky/a.turns,maxObservedPayout:a.maxPayout,terminalStreaks:a.terminalStreaks,betTiers:a.betTiers};}

const results={createdAt:new Date().toISOString(),seeds,R,correction,profiles,compositions,
 assumptions:{status:'hypothetical behavioral parameters; not fitted to player data',
  baseWagerProbabilities:{100:.1,1000:.25,10000:.65},
  initialBankrollMultiples:{10:.25,50:.5,200:.25},personality:'per-session cashout log-odds offset uniform [-.6,.6]',
  cashDecision:'logistic score from streak, selected win probability, cashout size, next payout, bankroll exposure, session P/L, target attainment and recent wins',
  tie:'continue same choice; no repeated cashout sampling until a win',
  gainProtection:'bankroll/session gains encourage cashout depending on profile',
  chasing:'session deficit reduces cashout; two losses can raise wager one allowed tier, capped at 10000 and available balance',
  settlement:'floor final payout to integer LIA; cash out if selected next payout would exceed wallet INT limit',
  draw:'independent uniform draw from all 52 cards; ties 1/13, A/2 redraw, losing fate shift 1/1000',
  horizon:'profile-specific session limits; quit at loss/profit limits or bankroll exhaustion',
  noClaims:'type frequencies and coefficients are analyst-chosen sensitivity scenarios, not human population estimates',
  expectedRtp:'independent importance trajectory per real wager at actual pre-hand session state; estimate weighted by actual stake volume',
  confidence:'95% approximate ratio intervals clustered by independent session; excludes model misspecification'},
 validation:{ruleSha256:createHash('sha256').update(await readFile(new URL('../../activity/server/highLowRules.mjs',import.meta.url))).digest('hex')},cases:[]};

// Kernel algebra used by the independent importance sampler.
let kernelChecks=0;for(let w=1;w<=48;w++)for(let l=0;l<=48-w;l++)for(let t=0;t<=3;t++){
 const n=w+l+t,q=(w+l*fate)/(w+l);assert.ok(Math.abs(((w+l*fate)/n)/q-(w+l)/n)<1e-12);kernelChecks++;}
results.validation.kernelChecks=kernelChecks;
await mkdir(out,{recursive:true});
for(const [caseIndex,cashShift] of [0,.75,-.75].entries()){
 const nPerSeed=cashShift===0?baseN:sensitivityN,caseResult={cashShift,label:cashShift===0?'基準行動':cashShift>0?'全体的に精算しやすい':'全体的に続行しやすい',profiles:[]};
 for(const [index,profile] of profiles.entries()){
  const a=accumulator();
  for(const seed of seeds){const rng=randomSource(seed+index*100003+caseIndex*900001),shadow=randomSource(seed+index*700001+caseIndex*300007+20000003);
   for(let session=0;session<nPerSeed;session++){
    const bDraw=rand(rng),base=bDraw<.1?100:bDraw<.35?1000:10000;
    const wealthDraw=rand(rng),initial=base*(wealthDraw<.25?10:wealthDraw<.75?50:200);
    const personality=(rand(rng)-.5)*1.2;
    let wallet=initial,lossRun=0,winRun=0,sessionWager=0,sessionExpected=0,sessionPaid=0,sessionCV=0;
    let ending='horizon';
    for(let hand=0;hand<profile.maxHands;hand++){
     const net=wallet-initial;
     if(net>=base*profile.goalUnits){ending='goal';break;}
     if(-net>=Math.min(initial*profile.lossFraction,base*profile.lossUnits)){ending='loss';break;}
     let desired=base;
     if(profile.raiseAfterLosses&&lossRun>=2)desired=base===100?1000:10000;
     const affordable=wagers.filter(w=>w<=desired&&w<=wallet);
     if(affordable.length===0){ending='broke';break;}
     const wager=affordable.at(-1),ctx={initial,base,wager,wallet,net,lossRun,winRun,personality,cashShift};
     const expected=play(profile,ctx,shadow,true);
     const actual=play(profile,ctx,rng,false,session<2&&hand<3);
     assert.ok(expected.expectedFactor>=0&&expected.expectedFactor<=1.035*correction+1e-9);
     const e=wager*expected.expectedFactor,c=actual.payout-.995*correction*wager*(actual.F-1);
     sessionWager+=wager;sessionExpected+=e;sessionPaid+=actual.payout;sessionCV+=c;
     a.hands++;a.unrounded+=wager*expected.unroundedFactor;a.terminalStreaks[actual.streak]++;a.betTiers[wager]++;
     a.turns+=actual.turns;a.risky+=actual.risky;a.maxPayout=Math.max(a.maxPayout,actual.payout);
     wallet+=actual.payout-wager;assert.ok(wallet>=0);
     if(actual.payout>wager){winRun++;lossRun=0;}else if(actual.payout<wager){lossRun++;winRun=0;}
    }
    a.sessions++;a.initial+=initial;a.net+=wallet-initial;
    if(wallet>initial)a.positiveSessions++;
    if(ending==='goal')a.goalStops++;if(ending==='loss')a.lossStops++;if(wallet<100)a.broke++;
    a.wagers+=sessionWager;a.expected+=sessionExpected;a.paid+=sessionPaid;a.cv+=sessionCV;
    a.w2+=sessionWager**2;a.e2+=sessionExpected**2;a.ew+=sessionExpected*sessionWager;
    a.p2+=sessionPaid**2;a.pw+=sessionPaid*sessionWager;a.c2+=sessionCV**2;a.cw+=sessionCV*sessionWager;
   }
  }
  const s=summary(a);caseResult.profiles.push({id:profile.id,label:profile.label,...s,aggregates:a});
  console.log(JSON.stringify({case:caseResult.label,profile:profile.label,...s}));
 }
 caseResult.mixtures=compositions.map(m=>{
  const entries=caseResult.profiles.map(p=>({p,w:m.shares[p.id]}));
  const denominator=entries.reduce((s,{p,w})=>s+w*p.aggregates.wagers/p.sessions,0);
  const numerator=entries.reduce((s,{p,w})=>s+w*p.aggregates.expected/p.sessions,0),ratio=numerator/denominator;
  const raw=entries.reduce((s,{p,w})=>s+w*p.aggregates.paid/p.sessions,0)/denominator;
  let variance=0;const turnoverShares={};
  for(const {p,w} of entries){const a=p.aggregates,n=a.sessions;
   const meanResidual=(a.expected-ratio*a.wagers)/n;
   const squareResidual=a.e2-2*ratio*a.ew+ratio*ratio*a.w2;
   const residualVariance=Math.max(0,(squareResidual-n*meanResidual**2)/(n-1));
   variance+=w*w*residualVariance/n;turnoverShares[p.id]=w*a.wagers/n/denominator;
  }
  return {id:m.id,label:m.label,populationShares:m.shares,turnoverShares,rtp:100*ratio,ci95HalfWidth:196*Math.sqrt(variance)/denominator,rawRtp:100*raw};
 });
 results.cases.push(caseResult);await writeFile(new URL('results.json',out),JSON.stringify(results,null,2)+'\n');
}
results.completedAt=new Date().toISOString();
results.totalSessions=results.cases.reduce((n,c)=>n+c.profiles.reduce((x,p)=>x+p.sessions,0),0);
results.ordinaryGames=results.cases.reduce((n,c)=>n+c.profiles.reduce((x,p)=>x+p.hands,0),0);
results.weightedTrajectories=results.ordinaryGames;
results.validation.simulationSha256=createHash('sha256').update(await readFile(new URL('./simulate.mjs',import.meta.url))).digest('hex');
await writeFile(new URL('results.json',out),JSON.stringify(results,null,2)+'\n');
console.log('COMPLETE '+JSON.stringify({sessions:results.totalSessions,games:results.ordinaryGames}));
