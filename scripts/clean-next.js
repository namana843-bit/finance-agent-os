import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dashboardPath = path.join(__dirname, '..', 'apps', 'dashboard');
const nextPath = path.join(dashboardPath, '.next');

if (fs.existsSync(nextPath)) {
  console.log(`Removing ${nextPath}`);
  fs.rmSync(nextPath, { recursive: true, force: true });
  console.log('Done.');
} else {
  console.log('.next directory does not exist.');
}