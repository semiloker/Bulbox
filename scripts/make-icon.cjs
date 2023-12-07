// scripts/make-icon.cjs — writes build/icon.ico, drawn by the app's own avatar
// painter so the icon comes from the project rather than a stock asset.
//
//   npx electron scripts/make-icon.cjs
//
// Run it again only if you want a different look; the .ico is committed.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'icon.ico');
const SIZE = 256;
const SEED = 'bulbox';

// Lift paintAvatar (and its two helpers) straight out of the renderer so the icon
// can never drift from what the app draws.
function painterSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const from = src.indexOf('function hash32');
  const to = src.indexOf('let avatarSalt');
  if (from < 0 || to < 0) throw new Error('avatar painter not found in public/app.js');
  return src.slice(from, to);
}

// An .ico is a 6-byte header, one 16-byte directory entry per image, then the
// image payloads. A PNG payload is allowed as-is since Vista.
function icoFromPng(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = SIZE >= 256 ? 0 : SIZE; // 0 means 256
  entry[1] = SIZE >= 256 ? 0 : SIZE;
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE });
  await win.loadURL('data:text/html,<body></body>');

  const dataUrl = await win.webContents.executeJavaScript(
    '(() => {' +
      painterSource() +
      ' const c = document.createElement("canvas");' +
      ' c.width = c.height = ' + SIZE + ';' +
      ' paintAvatar(c, ' + JSON.stringify(SEED) + ', 0);' +
      ' return c.toDataURL("image/png"); })()'
  );

  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, icoFromPng(png));
  console.log('wrote', path.relative(ROOT, OUT), '-', fs.statSync(OUT).size, 'bytes');
  app.exit(0);
});
