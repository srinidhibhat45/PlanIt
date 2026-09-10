/* Paste into DevTools (or load from /contrast-audit.js in dev) and call
   window.__audit() to get every visible text node's contrast ratio against
   its real painted background, with AA and AAA verdicts. */

window.__audit = () => {
  const lin=(c)=>{c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);};
  const L=([r,g,b])=>0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
  const parse=(s)=>{const m=s.match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);return p.length>=3?[p[0],p[1],p[2],p[3]??1]:null;};
  const ratio=(a,b)=>{const la=L(a),lb=L(b);const hi=Math.max(la,lb),lo=Math.min(la,lb);return (hi+0.05)/(lo+0.05);};
  const blend=(fg,bg)=>fg[3]>=1?fg.slice(0,3):fg.slice(0,3).map((c,i)=>c*fg[3]+bg[i]*(1-fg[3]));
  function bgOf(el){let n=el;while(n&&n!==document.documentElement){const c=parse(getComputedStyle(n).backgroundColor);if(c&&c[3]>0.92)return c.slice(0,3);n=n.parentElement;}return parse(getComputedStyle(document.body).backgroundColor)?.slice(0,3)||[0,0,0];}
  const out=[];const seen=new Set();
  for(const el of document.querySelectorAll('*')){
    if(el.offsetParent===null&&el.tagName!=='BODY')continue;
    if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim().length>1))continue;
    const cs=getComputedStyle(el);
    if(parseFloat(cs.opacity)<0.6)continue;
    if(el.closest('[disabled]')||el.hasAttribute('disabled')||el.closest('.sr-only,.announcer'))continue;
    const fg=parse(cs.color); if(!fg)continue;
    const bg=bgOf(el); const r=ratio(blend(fg,bg),bg);
    const px=parseFloat(cs.fontSize), bold=parseInt(cs.fontWeight)>=700;
    const large=px>=24||(px>=18.66&&bold);
    const key=(el.className||el.tagName)+'|'+cs.color+'|'+px; if(seen.has(key))continue; seen.add(key);
    out.push({sel:String(el.className||el.tagName).split(' ')[0]||el.tagName,ratio:+r.toFixed(2),passAA:r>=(large?3:4.5),passAAA:r>=(large?4.5:7),text:(el.textContent||'').trim().slice(0,22)});
  }
  out.sort((a,b)=>a.ratio-b.ratio);
  return {total:out.length, failAA:out.filter(r=>!r.passAA).map(r=>r.sel+' '+r.ratio+' "'+r.text+'"'), aaa:(out.filter(r=>r.passAAA).length/out.length*100).toFixed(0)+'%', lowest:out.slice(0,4)};
};
'audit ready'
