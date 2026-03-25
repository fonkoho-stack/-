const fs = require('fs');
const path = require('path');

const imgDir = path.join(__dirname, 'miniprogram', 'images');
if (!fs.existsSync(imgDir)) {
  fs.mkdirSync(imgDir, { recursive: true });
}

// 1x1 transparent PNG
const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const buffer = Buffer.from(base64Data, 'base64');

const files = [
  'icon_upload.png',
  'icon_upload_active.png',
  'icon_schedule.png',
  'icon_schedule_active.png',
  'icon_settings.png',
  'icon_settings_active.png'
];

files.forEach(f => {
  fs.writeFileSync(path.join(imgDir, f), buffer);
});

console.log('Successfully created placeholder images.');
