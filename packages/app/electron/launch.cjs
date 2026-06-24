// Lança o Electron com o ambiente limpo. Se ELECTRON_RUN_AS_NODE estiver setado
// (alguns terminais/IDEs setam), o electron.exe age como Node puro e o app não sobe
// (require('electron') vira string). Aqui removemos essa var antes de spawnar.
const { spawn } = require('child_process');
const path = require('path');
const electronBin = require('electron'); // em node puro, exporta o caminho do binário

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const appDir = path.join(__dirname, '..');
const child = spawn(electronBin, [appDir], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
