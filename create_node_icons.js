const fs = require('fs');
const path = require('path');

const imgDir = path.join(__dirname, 'miniprogram', 'images');
if (!fs.existsSync(imgDir)) {
  fs.mkdirSync(imgDir, { recursive: true });
}

const grayB64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2OMjIz8z8DAwMgwdgkA21sDAQEHAxsAAAAASUVORK5CYII=";
const greenB64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2NkgID/DAwMjDAGNgwA92MFAQ7HjxEAAAAASUVORK5CYII=";

const grayBuf = Buffer.from(grayB64, 'base64');
const greenBuf = Buffer.from(greenB64, 'base64');

fs.writeFileSync(path.join(imgDir, 'icon_upload.png'), grayBuf);
fs.writeFileSync(path.join(imgDir, 'icon_upload_active.png'), greenBuf);
fs.writeFileSync(path.join(imgDir, 'icon_schedule.png'), grayBuf);
fs.writeFileSync(path.join(imgDir, 'icon_schedule_active.png'), greenBuf);
fs.writeFileSync(path.join(imgDir, 'icon_settings.png'), grayBuf);
fs.writeFileSync(path.join(imgDir, 'icon_settings_active.png'), greenBuf);

console.log("Successfully created real solid placeholder images.");
