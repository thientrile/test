'use strict';

// Mở report HTML tĩnh bằng trình duyệt mặc định của OS — KHÔNG cần dựng
// FE/web server. Report là self-contained (data nhúng thẳng vào HTML), nên
// chỉ cần mở file:// là xem được, không lỗi CORS.
//
// Dùng qua: `npm run report:open` (hoặc `npm run report` để build + open).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPORT = path.resolve(__dirname, '..', 'k6', 'reports', 'index.html');

if (!fs.existsSync(REPORT)) {
  console.error(`[open-report] không tìm thấy: ${REPORT}`);
  console.error('[open-report] Hãy chạy một test rồi `npm run report:build` trước (hoặc `npm run report`).');
  process.exit(1);
}

const platform = process.platform;
let cmd;
let args;
if (platform === 'win32') {
  // cmd /c start "" "<path>"  — title rỗng "" để start không hiểu nhầm path là title.
  cmd = process.env.ComSpec || 'cmd';
  args = ['/c', 'start', '', REPORT];
} else if (platform === 'darwin') {
  cmd = 'open';
  args = [REPORT];
} else {
  cmd = 'xdg-open';
  args = [REPORT];
}

const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
child.on('error', (err) => {
  console.error('[open-report] mở thất bại:', err.message);
  console.error(`[open-report] Mở thủ công: ${REPORT}`);
  process.exit(1);
});
child.unref();
console.log(`[open-report] đã mở ${REPORT}`);
