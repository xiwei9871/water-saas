import sharp from 'sharp';
const [,,img,x,y,r] = process.argv;
await sharp(img).extract({left:Math.max(0,+x-+r*1.1|0),top:Math.max(0,+y-+r*1.1|0),width:+r*2.2|0,height:+r*2.2|0}).resize(+r*8,+r*8).png().toFile('/tmp/bigdial.png');
console.log('ok');
