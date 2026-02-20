const { createCanvas, Image } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, 'resources', 'icons', 'app-icon.svg');
const pngPath = path.join(__dirname, 'resources', 'icons', 'app-icon.png');

async function convert() {
    const svgBuffer = fs.readFileSync(svgPath);
    const img = new Image();
    img.src = svgBuffer;

    // Wait for image to be populated
    await new Promise(resolve => setTimeout(resolve, 100));

    const canvas = createCanvas(512, 512);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0, 512, 512);

    const pngBuffer = canvas.toBuffer('image/png');
    fs.writeFileSync(pngPath, pngBuffer);
    console.log('Successfully created app-icon.png');
}

convert().catch(console.error);
