const sharp = require('sharp');
(async () => {
const path = require('node:path');
const W = 64, H = 64, B = 12, S = 8, C = 3;
const src = Buffer.alloc(W*H*C);
function put(buf,w,x,y,c){const i=(y*w+x)*3;buf[i]=c[0];buf[i+1]=c[1];buf[i+2]=c[2];}
for(let y=0;y<H;y++) for(let x=0;x<W;x++) {
  let c=[28+Math.floor(x*1.2),45+Math.floor(y*.8),92+Math.floor((x+y)*.35)];
  if(x<10&&y<10) c=((x+y)%2===0)?[245,220,42]:[20,20,20];
  if(y===0) c=[235,50+Math.floor(x*1.5),70];
  if(x===0) c=[40,210-Math.floor(y*1.5),100];
  if(x<5&&y<5) c=[255,255,255];
  if(x>=4&&x<8&&y>=1&&y<4) c=[10,10,10];
  put(src,W,x,y,c);
}
function sample(x,y){x=Math.max(0,Math.min(W-1,x));y=Math.max(0,Math.min(H-1,y));const i=(y*W+x)*3;return [...src.subarray(i,i+3)];}
const names=['dominant-side','reflected-patch','edge-blend','constant-corner'];
const images=[];
for(let mode=0;mode<4;mode++){
 const ow=W+2*B, oh=H+2*B, out=Buffer.alloc(ow*oh*C);
 for(let oy=0;oy<oh;oy++) for(let ox=0;ox<ow;ox++){
  const x=ox-B,y=oy-B; let c;
  if(x>=0&&x<W&&y>=0&&y<H) c=sample(x,y);
  else {
   const left=x<0,right=x>=W,top=y<0,bottom=y>=H;
   const dx=left?-x:right?x-W+1:0,dy=top?-y:bottom?y-H+1:0;
   if((left||right)&&(top||bottom)){
    const cx=left?dx-1:W-dx, cy=top?dy-1:H-dy;
    if(mode===0) c=dx>=dy ? sample(cx,top?0:H-1) : sample(left?0:W-1,cy);
    else if(mode===1) c=sample(cx,cy);
    else if(mode===2){const a=sample(left?0:W-1,cy),b=sample(cx,top?0:H-1);const t=dx/(dx+dy);c=a.map((v,i)=>Math.round(v*(1-t)+b[i]*t));}
    else c=sample(left?0:W-1,top?0:H-1);
   } else if(top) c=sample(x,Math.min(S-1,dy-1));
   else if(bottom) c=sample(x,H-1-Math.min(S-1,dy-1));
   else if(left) c=sample(Math.min(S-1,dx-1),y);
   else c=sample(W-1-Math.min(S-1,dx-1),y);
  }
  put(out,ow,ox,oy,c);
 }
 const scale=5, scaled=await sharp(out,{raw:{width:W+2*B,height:H+2*B,channels:3}}).resize(ow*scale,oh*scale,{kernel:'nearest'}).png().toBuffer();
 const label=Buffer.from(`<svg width="${ow*scale}" height="26"><rect width="100%" height="100%" fill="#f5f5f5"/><text x="8" y="19" font-family="Arial" font-size="15" fill="#111">${names[mode]}</text></svg>`);
 const labeled=await sharp(scaled).extend({top:26,bottom:0,left:0,right:0,background:'#f5f5f5'}).composite([{input:label,left:0,top:0}]).png().toBuffer();
 images.push(labeled);
}
const panelW=(W+2*B)*5, panelH=(W+2*B)*5+26;
const sheet=Buffer.alloc(panelW*2*panelH*2*3,245);
for(let i=0;i<images.length;i++){
 const x=(i%2)*panelW,y=Math.floor(i/2)*panelH;
 const raw=await sharp(images[i]).removeAlpha().raw().toBuffer({resolveWithObject:true});
 for(let row=0;row<raw.info.height;row++) raw.data.copy(sheet,((y+row)*panelW*2+x)*3,row*raw.info.width*3,(row+1)*raw.info.width*3);
}
await sharp(sheet,{raw:{width:panelW*2,height:panelH*2,channels:3}})
  .png()
  .toFile(path.join(__dirname, 'candidate-matrix.png'));
console.log(`Wrote ${path.join(__dirname, 'candidate-matrix.png')}`);

})().catch((error) => { console.error(error); process.exitCode = 1; });
